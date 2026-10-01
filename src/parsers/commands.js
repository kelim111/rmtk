/* =========================================================================
   事件指令表：把不同版本 RPG Maker 的指令编号，归一成同一套「语义」。
   归一后的指令长这样：
     { code, indent, params, kind, text?, ... }
   kind 的取值：
     text        一行对话 / 文章
     textHeader  文章的开头（带说话人、脸图）
     choice      选项
     choiceWhen  选项分支
     branch      条件分歧
     transfer    场所移动
     setSwitch / condSwitch
     setVariable / condVariable
     selfSwitch
     bgm / bgs / se / me / stopBgm
     picture     显示图片
     loop / breakLoop
     label / jump
     callCommon  公共事件
     wait
     script      脚本
     comment     注释
     battle / shop / name / save / gameover / menu / itemSelect / ...
   ========================================================================= */

export const CMD = {
  TEXT: 101,
  TEXT_LINE: 401,
  CHOICE: 102,
  CHOICE_WHEN: 402,
  CHOICE_END: 404,
  SCROLL_TEXT: 105,
  SCROLL_TEXT_LINE: 405,
  CONDITION: 111,
  CONDITION_ELSE: 411,
  CONDITION_END: 412,
  LOOP: 112,
  BREAK_LOOP: 113,
  EXIT_EVENT: 115,
  LABEL: 118,
  JUMP: 119,
  SWITCH: 121,
  VARIABLE: 122,
  SELF_SWITCH: 123,
  TIMER: 124,
  TRANSFER: 201,
  SET_EVENT_LOCATION: 203,
  SCROLL_MAP: 204,
  BGM: 241, BGM_STOP: 242, BGS: 245, BGS_STOP: 246, ME: 249, SE: 250,
  PICTURE: 231, PICTURE_MOVE: 232,
  BATTLE: 301, SHOP: 302, NAME_INPUT: 303, SAVE: 352, GAMEOVER: 353, MENU: 351,
  ITEM_SELECT: 104,
  CALL_COMMON: 117,
  WAIT: 106,
  SCRIPT: 355,
  COMMENT: 108,
  COMMENT_LINE: 408,
  PLUGIN: 356,
  PLUGIN_MZ: 357,
  COMMENT_MZ: 657
};

/** 各引擎的「一行对话」编号（归一化时用） */
export const TEXT_CODES = {
  MV: [401, 405],
  MZ: [401, 405],
  VX: [401, 405],
  VXAce: [401, 405],
  XP: [101, 401],       // XP 的 101 本身就带文字
  2000: [10110],
  2003: [10110]
};

/** 各引擎的「文章开头」编号（带脸图/说话人） */
export const TEXT_HEADER_CODES = {
  MV: [101], MZ: [101], VX: [101], VXAce: [101], XP: [], 2000: [], 2003: []
};

/** 各引擎的「场所移动」编号 */
export const TRANSFER_CODES = {
  MV: [201], MZ: [201], VX: [201], VXAce: [201], XP: [201], 2000: [20110], 2003: [20110]
};

export function kindOf(engine, code) {
  if (TEXT_CODES[engine]?.includes(code)) return 'text';
  if (TEXT_HEADER_CODES[engine]?.includes(code)) return 'textHeader';
  if (TRANSFER_CODES[engine]?.includes(code)) return 'transfer';
  switch (code) {
    case CMD.CHOICE: return 'choice';
    case CMD.CHOICE_WHEN: return 'choiceWhen';
    case CMD.CHOICE_END: return 'choiceEnd';
    case CMD.CONDITION: return 'condSwitch';
    case CMD.CONDITION_ELSE: return 'else';
    case CMD.CONDITION_END: return 'endIf';
    case CMD.LOOP: return 'loop';
    case CMD.BREAK_LOOP: return 'breakLoop';
    case CMD.EXIT_EVENT: return 'exitEvent';
    case CMD.LABEL: return 'label';
    case CMD.JUMP: return 'jump';
    case CMD.SWITCH: return 'setSwitch';
    case CMD.VARIABLE: return 'setVariable';
    case CMD.SELF_SWITCH: return 'selfSwitch';
    case CMD.CALL_COMMON: return 'callCommon';
    case CMD.WAIT: return 'wait';
    case CMD.SCRIPT: return 'script';
    case CMD.COMMENT: case CMD.COMMENT_LINE: case CMD.COMMENT_MZ: return 'comment';
    case CMD.BGM: return 'bgm';
    case CMD.BGM_STOP: return 'stopBgm';
    case CMD.BGS: return 'bgs';
    case CMD.BGS_STOP: return 'stopBgs';
    case CMD.ME: return 'me';
    case CMD.SE: return 'se';
    case CMD.PICTURE: return 'picture';
    case CMD.BATTLE: return 'battle';
    case CMD.SHOP: return 'shop';
    case CMD.NAME_INPUT: return 'nameInput';
    case CMD.SAVE: return 'save';
    case CMD.MENU: return 'menu';
    case CMD.GAMEOVER: return 'gameover';
    case CMD.ITEM_SELECT: return 'itemSelect';
    case CMD.PLUGIN: case CMD.PLUGIN_MZ: return 'plugin';
    default: return 'other';
  }
}

/** 条件分歧的「条件种类」（把 111 的第一个参数翻成人话） */
export const CONDITION_TYPES = {
  0: 'switch',
  1: 'variable',
  2: 'selfSwitch',
  3: 'item',
  4: 'actor',
  5: 'enemy',
  6: 'character',
  7: 'gold',
  8: 'timer',
  9: 'vehicle',
  11: 'button',
  12: 'script',
  13: 'other'
};

export const TRIGGER_NAMES = {
  0: '按决定键',
  1: '玩家接触',
  2: '事件接触',
  3: '自动执行',
  4: '并行处理'
};

export const VARIABLE_OPERATIONS = {
  0: '=',
  1: '+=',
  2: '-=',
  3: '*=',
  4: '/=',
  5: '%='
};

export const VARIABLE_OPERANDS = {
  0: '常量',
  1: '变量',
  2: '随机数',
  3: '游戏数据',
  4: '脚本'
};
