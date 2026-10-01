/* =========================================================================
   翻译器：把「抽取出来的对话」翻译成目标语言。
   内置三种：
     offline  纯离线：用术语表 + 可选的人名表做替换（不需要联网、不花钱）
     openai   调 OpenAI 的 Chat Completions，按批翻译（需要 OPENAI_API_KEY）
     passthrough  原样返回（用来验证整条流水线 / 只导出待译表）
   翻译器只要实现 translateBatch(items, ctx) → string[] 就能插进来。
   ========================================================================= */

/* --------------------------------------------------------------- 离线 */

export function createOfflineTranslator({ glossary = {}, keepNames = true } = {}) {
  const rules = Object.entries(glossary)
    .filter(([k]) => k)
    .sort((a, b) => b[0].length - a[0].length);
  return {
    name: 'offline',
    async translateBatch(items) {
      return items.map((it) => {
        let out = it.text;
        for (const [from, to] of rules) out = out.split(from).join(to);
        return out;
      });
    },
    note: keepNames
      ? '离线术语替换：只换术语表里出现的词，其余保持原文'
      : '离线术语替换（不保留原文格式）'
  };
}

export function createPassthroughTranslator() {
  return {
    name: 'passthrough',
    async translateBatch(items) { return items.map((it) => it.text); },
    note: '原样返回：不翻译，只用来看「待译表」长什么样'
  };
}

/* ------------------------------------------------------ OpenAI（可选） */

export function createOpenAITranslator({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.RMTK_MODEL || 'gpt-4o-mini',
  baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  targetLang = '中文（简体）',
  sourceLang = '自动判断',
  glossary = {},
  concurrency = 4,
  batchSize = 20,
  dryRun = false,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!apiKey && !dryRun) {
    throw new Error('没有找到 OPENAI_API_KEY。可以：export OPENAI_API_KEY=sk-... 或者用 --translator offline');
  }
  const glossaryText = Object.entries(glossary).map(([k, v]) => `- ${k} ⇒ ${v}`).join('\n');
  const system = [
    `你是游戏本地化译者。把 RPG Maker 游戏里的台词翻译成${targetLang}。`,
    '要求：',
    '1. 只输出 JSON 数组，长度与输入严格一致，不要任何解释。',
    '2. 保留原有的换行、全角空格、『』「」等符号的位置关系；不要翻译控制符（如 \\V[1]、\\C[1]、%1）。',
    '3. 语气贴合角色：台词短、口语化，不要翻译腔。',
    '4. 人名/专有名词按下表统一：',
    glossaryText || '- （无）'
  ].join('\n');

  const callOnce = async (batch) => {
    const user = JSON.stringify(batch.map((b, i) => ({ i, text: b.text })), null, 0);
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI 接口返回 ${res.status}：${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content ?? '[]';
    const match = content.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(match ? match[0] : content);
    const usage = json.usage || {};
    return { arr, usage };
  };

  return {
    name: 'openai',
    model,
    async translateBatch(items, ctx = {}) {
      if (dryRun) return items.map((it) => it.text);
      const batches = [];
      for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));
      const results = new Array(items.length);
      let cursor = 0;
      const workers = new Array(Math.min(concurrency, batches.length)).fill(0).map(async () => {
        while (true) {
          const myIndex = cursor++;
          if (myIndex >= batches.length) return;
          const batch = batches[myIndex];
          let attempt = 0, ok = false, lastErr = null;
          while (attempt < 3 && !ok) {
            try {
              const { arr, usage } = await callOnce(batch);
              batch.forEach((it, i) => {
                const t = arr.find((x) => Number(x.i) === i)?.text;
                results[items.indexOf(it)] = typeof t === 'string' && t ? t : it.text;
              });
              ok = true;
              if (ctx.onUsage && usage) ctx.onUsage(usage);
            } catch (e) {
              lastErr = e;
              attempt++;
              await new Promise((r) => setTimeout(r, 500 * attempt));
            }
          }
          if (!ok && ctx.onError) ctx.onError(lastErr, batch);
        }
      });
      await Promise.all(workers);
      return results.map((r, i) => (typeof r === 'string' && r ? r : items[i].text));
    },
    note: `OpenAI ${model}（${sourceLang} → ${targetLang}）`
  };
}

export function createTranslator(type, options = {}) {
  switch ((type || 'offline').toLowerCase()) {
    case 'openai': return createOpenAITranslator(options);
    case 'offline': return createOfflineTranslator(options);
    case 'passthrough': case 'none': return createPassthroughTranslator();
    default: throw new Error(`不认识的翻译器：${type}（可选 offline / openai / passthrough）`);
  }
}
