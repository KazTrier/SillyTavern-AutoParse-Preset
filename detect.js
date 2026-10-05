/**
 * 纯逻辑模块：从「预设文本」里推断思维链的前后缀标签。
 *
 * 设计目标（按真实预设的形态倒推，含踩过的坑）：
 *  - 预设通常用一句话说明思维链格式，例如
 *      "reasoning steps strictly using the shown thought template wrapped in `<thought></thought>` tag"
 *      "把思考过程写在 <inner_voice></inner_voice> 之间"
 *      "{{setvar::story_think_format:: <story_driver>...</story_driver> }}"
 *  - **优先读「思维链条目」**：很多大型预设（如咩咩预设）有上百条提示词，思维链格式写在
 *    名字带「思维链 / 思考 / 推理 / CoT」的条目里；其它条目里出现的标签（格式外壳、状态栏、
 *    变量名）都是干扰项。
 *  - **排除 STscript 宏**：`{{setvar::x::}}` / `{{getvar::x}}` 这类不是模型输出的标签。
 *  - **不跨条目配对**：开标记与闭合标记必须在**同一条目内、且闭合在后**，否则会把
 *    `【输出推理过程】` 和另一条目里的 `</acg_think>` 硬凑成一对（真实踩过的 bug）。
 *  - 同一份预设里往往还夹着大量**结构性标签**（<npc> <CONTEXT> <INSTRUCTIONS> <CHAT_HISTORY> …），
 *    它们不是思维链，必须排除。
 *  - 有的预设根本没有思维链标签 —— 这时必须返回「无」，宁可不改也不改错。
 *
 * 打分只依赖三类证据：
 *   1. 标签名本身是否与思维链相关（keyword）
 *   2. 出现该标签的那一行里，是否同时有「包裹/写在/inside/tag」这类措辞和思维链字样（instruction）
 *   3. 是开闭成对，还是只出现了单边（symmetric / keyword / synthesized）
 * 外加：是否来自思维链条目（cotEntry）、条目是否启用（enabled）、结构性标签黑名单。
 *
 * 本文件不 import 任何 SillyTavern 模块，可离线测试（见 test/detect.test.mjs）。
 */

/** 会被扫描的括号风格 */
export const TAG_STYLES = Object.freeze([
    { left: '<|', right: '|>' },
    { left: '<<', right: '>>' },
    { left: '[[', right: ']]' },
    { left: '{{', right: '}}' },
    { left: '<', right: '>' },
    { left: '【', right: '】' },
    { left: '『', right: '』' },
    { left: '「', right: '」' },
    { left: '[', right: ']' },
    { left: '(', right: ')' },
    { left: '|', right: '|' },
]);

/**
 * 标签名里允许出现的字符：不能是任何分隔符，也不能有空白。
 * 允许全角竖线 ｜，因为 DeepSeek V3.1 的结束标记是 `<｜end▁of▁thinking｜>` 这种形式。
 */
const NAME_CHARS = '[^<>|【】『』「」\\[\\]{}()\\s]';

/** 标签名 / 附近文本里出现这些词，说明和思维链有关（注意：**不含** 内心/心声/独白 —— 那些是给玩家看的正文内容） */
const THINKING_PATTERN = /(think|thought|reason|analysis|analy[sz]e|chain[_\s-]?of[_\s-]?(thought|think)|ecot|cot|scratchpad|reflect|deliberat|脑内|思考|思维|推理|沉思|分析)/i;

/**
 * 条目名 / 标识符里出现这些词，说明这条提示词和思维链有关。
 * 不含 内心 / 心声 / 独白 / 心理 —— 那些条目是「NPC 内心话」这类**展示用**内容，不是思维链。
 */
export const COT_ENTRY_PATTERN = /(思维链|思维|思考|推理|脑内|沉思|ecot|cot|chain[_\s-]?of[_\s-]?(thought|think)|think|thought|reason|scratchpad|reflect)/i;

/** 条目名**开头**就是思维链词（去掉前面的 emoji/符号后），例如「思维链动态开场」「📌 COT 接收」 */
const PRIMARY_COT_PATTERN = /^(思维链|思维|思考|推理|脑内|ecot|cot|chain|think|thought|reason)/i;

/**
 * 条目名里出现这些词，说明这条提示词的主题**不是**思维链（开关、格式、状态栏、世界书…）。
 * 只有「名字开头就是思维链词」的条目才能豁免，避免 `🔌NSFW总开关…思维链` 这种多主题名混进来。
 */
const TOPIC_BLOCK_PATTERN = /(nsfw|破甲|jailbreak|开关|状态栏|status|世界书|worldbook|lore|记忆|memory|表情包|emoji|视觉|图片|image|好感度|affinity|选项|button|regex|正则|格式|输出顺序|html|前端|文风|语言|人称|视角|物品|技能|任务|地点|侦查|叙事|写作|总结)/i;

/**
 * 「反思维链」条目：这类条目的用途是**压制/关闭**模型原生思维链，
 * 例如「卡原生思维链-预填充」里写的其实是 `</think>` `</thinking>` 这类**收尾标记**，
 * 它把原生思维链掐掉，绝不是本预设要用的思维链格式。这类条目整个排除。
 */
const ANTI_COT_ENTRY_PATTERN = /(卡原生|原生思维链|禁用|🈲|关闭思维|关闭思考|不输出思维|禁止输出|干掉|anti[_\s-]?think|no[_\s-]?think|think[_\s-]?(kill|off|disable))/i;

/** 压制标记：出现它就说明这段是「掐掉思维链」的预填充 */
const NO_TRANS_PATTERN = /no[_\s-]?trans/i;

/**
 * 形如 `<acg_think_format>` / `<story_think_format>` 的标签只是预设用来**包裹格式示例的外壳**，
 * 不是模型真正输出的内容块（真实预设里很常见），推断时重罚。
 */
const FORMAT_SHELL_PATTERN = /(^|[_\s-])(format|fmt|格式|外壳)$/i;

/**
 * STscript / SillyTavern 宏 形式的 token，不是模型输出的标签。
 * 例如 `{{setvar::acg_think_format::}}`、`{{getvar::story_think_format}}`。
 */
const MACRO_NAME_PATTERN = /::|^(setvar|getvar|addvar|delvar|incvar|decvar|tempvar|input|pick|random|roll)\b/i;

/** 「把它包起来 / 写在里面」这类措辞 */
const WRAP_CUE_PATTERN = /(wrap|wrapped|tagged|\btags?\b|inside|between|surround|enclose|using|use\s+the|spans?\b|put\s|place\s|write\s|output\s|begin\s|start\s|format|格式|标签|包裹|写在|放在|括在|之间|之内|中间|用\s*[<【「『\[{(]|使用|输出|以.{0,6}(开头|结尾))/i;

/** 结构性 / 格式类标签，肯定不是思维链 */
export const STRUCTURAL_TAG_BLOCKLIST = Object.freeze([
    'instructions', 'instruction', 'context', 'history', 'chat_history', 'chathistory',
    'scenario', 'examples', 'example', 'npc', 'npcs', 'player', 'user', 'char',
    'character', 'characters', 'goal', 'objective', 'details', 'world', 'lore',
    'summary', 'description', 'personality', 'system', 'main', 'prompt', 'jailbreak',
    'nsfw', 'rules', 'guidelines', 'format', 'formatting', 'output', 'tags', 'tag',
    'latest_message', 'story_progression', 'realism', 'favoritism', 'character_growth',
    'story_scene', 'memory_log', 'status', 'affinity', 'wlog',
    // 正文/素材/展示类（真实预设里极常见的干扰项）
    'content', 'worldinfo', 'user_input', 'thinking_requirements', 'sample',
    'npc_log', 'emoji', 'giggle', 'status_bar',
]);

/** XML 风格才能安全地合成闭合标签 */
const SYNTHESIZABLE_STYLES = new Set(['<', '<|', '<<']);

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 该名字是「闭合 / 结束标记」吗？
 * 覆盖 `</x>`、`<|/x|>`、`<｜end▁of▁thinking｜>`、`<end_thinking>` 等形式。
 * @param {string} name
 */
function isTerminatorName(name) {
    const value = String(name).trim();
    if (/^[/|｜]/.test(value)) {
        return true;
    }
    if (/^(end|stop|close|finish)\b/i.test(value)) {
        return true;
    }
    if (/(^|[_\s-])(end|stop|close|finish)([_\s-]|$)/i.test(value)) {
        return true;
    }
    return false;
}

function isClosingName(name) {
    const value = String(name).trim();
    return value === '' || isTerminatorName(value);
}

/**
 * 把预设对象里所有可能有用的字符串收集起来。
 * @param {object} preset getChatCompletionPreset() 的返回值
 * @param {{limit?: number, enabledIds?: Set<string>|null}} [options]
 *        enabledIds：当前 prompt_order 里启用的条目 identifier，用于给候选加权
 * @returns {{source: string, text: string, name: string, identifier: string, enabled?: boolean}[]}
 */
export function collectPresetTexts(preset, { limit = 400000, enabledIds = null } = {}) {
    const chunks = [];
    let budget = limit;

    const lookupEnabled = (identifier) => {
        if (!enabledIds || typeof enabledIds.has !== 'function') {
            return undefined;
        }
        try {
            return enabledIds.has(String(identifier));
        } catch {
            return undefined;
        }
    };

    const push = (source, text, meta = {}) => {
        const value = String(text ?? '');
        if (budget <= 0 || value.trim() === '') {
            return;
        }
        const clipped = value.length > budget ? value.slice(0, budget) : value;
        budget -= clipped.length;
        chunks.push({
            source,
            text: clipped,
            name: String(meta.name ?? ''),
            identifier: String(meta.identifier ?? source),
            enabled: meta.enabled,
        });
    };

    const prompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
    for (const prompt of prompts) {
        if (!prompt || typeof prompt !== 'object') {
            continue;
        }
        const identifier = String(prompt.identifier ?? 'prompt');
        const name = String(prompt.name ?? '');
        push(`${identifier}${name ? ` (${name})` : ''}`, `${name}\n${prompt.content ?? ''}`, {
            name,
            identifier,
            enabled: lookupEnabled(identifier),
        });
    }

    const SKIP_KEY = /(proxy|endpoint|api_?url|api_?key|secret|password|authorization|bearer)/i;
    const walk = (value, pathParts, depth) => {
        if (budget <= 0 || depth > 4 || !value || typeof value !== 'object') {
            return;
        }
        for (const [key, child] of Object.entries(value)) {
            // 跳过 prompts（上面单独处理）、密钥类字段、以及预设里内嵌的 extensions（正则脚本等，
            // 那些不是提示词正文，真实预设里它们的标签会把结果带偏）
            if (SKIP_KEY.test(key) || key === 'prompts' || key === 'extensions') {
                continue;
            }
            if (typeof child === 'string') {
                if (/^https?:\/\//i.test(child)) {
                    continue;
                }
                const path = pathParts.concat(key).join('.');
                push(path, child, { identifier: path, name: path });
            } else if (child && typeof child === 'object') {
                walk(child, pathParts.concat(key), depth + 1);
            }
        }
    };
    walk(preset, [], 0);

    return chunks;
}

/**
 * 找出所有括号标记，并记录它出现在哪些条目、以及在该条目内的首个偏移。
 * @param {{source?: string, text?: string, name?: string, identifier?: string, enabled?: boolean}[]} chunks
 */
/**
 * 给条目名 / 标识符评「思维链相关度」：
 *   3 = 名字（去掉开头 emoji/符号后）**就是**思维链词开头，最可信
 *   2 = 名字里含思维链词且主题不冲突
 *   0 = 与思维链无关，或名字主题是开关 / 格式 / 状态栏 / 世界书 / 内心话 之类
 */
function cotTierOf(name, identifier) {
    for (const candidate of [name, identifier]) {
        const stripped = String(candidate ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
        if (stripped === '') {
            continue;
        }
        if (PRIMARY_COT_PATTERN.test(stripped)) {
            return 3;
        }
        if (COT_ENTRY_PATTERN.test(stripped) && !TOPIC_BLOCK_PATTERN.test(stripped)) {
            return 2;
        }
    }
    return 0;
}

function tokenize(chunks) {
    const tokens = new Map();
    const chunkMeta = chunks.map(chunk => {
        const name = String(chunk?.name ?? '');
        const identifier = String(chunk?.identifier ?? '');
        return {
            source: String(chunk?.source ?? ''),
            name,
            identifier,
            enabled: chunk?.enabled,
            cotTier: cotTierOf(name, identifier),
            antiByName: ANTI_COT_ENTRY_PATTERN.test(name) || ANTI_COT_ENTRY_PATTERN.test(identifier),
            text: String(chunk?.text ?? ''),
            opens: 0,
            closes: 0,
            anti: false,
        };
    });

    chunks.forEach((chunk, chunkIndex) => {
        const text = String(chunk?.text ?? '');
        if (text === '') {
            return;
        }
        const lines = text.split('\n');
        const meta = chunkMeta[chunkIndex];

        for (const style of TAG_STYLES) {
            const pattern = new RegExp(`${escapeRegExp(style.left)}(${NAME_CHARS}{1,32})${escapeRegExp(style.right)}`, 'g');
            for (const match of text.matchAll(pattern)) {
                const full = match[0];
                const name = match[1];
                if (name.trim() === '' || full.includes('\n')) {
                    continue;
                }
                // STscript 宏（{{setvar::x::}} 等）不是模型输出的标签
                if (MACRO_NAME_PATTERN.test(name)) {
                    continue;
                }

                const proposedKind = isClosingName(name) ? 'close' : 'open';
                if (proposedKind === 'close') {
                    meta.closes += 1;
                } else {
                    meta.opens += 1;
                }

                let token = tokens.get(full);
                if (!token) {
                    token = {
                        text: full,
                        name,
                        style: style.left,
                        styleIndex: TAG_STYLES.indexOf(style),
                        kind: proposedKind,
                        count: 0,
                        presences: new Map(),
                        lines: [],
                    };
                    tokens.set(full, token);
                } else if (proposedKind === 'open') {
                    // 同一串文字既能被当成开标记又能被当成闭标记时，优先当开标记
                    token.kind = 'open';
                }

                token.count += 1;
                if (!token.presences.has(chunkIndex)) {
                    token.presences.set(chunkIndex, match.index);
                }
                // 收集「包含该标签的行」，最多 5 条（带上**上一行**做上下文：
                // 预设常常上一行写「请严格按照以下格式输出：」，下一行才是标签）
                if (token.lines.length < 5) {
                    for (let i = 0; i < lines.length && token.lines.length < 5; i++) {
                        if (!lines[i].includes(full)) {
                            continue;
                        }
                        const context = `${i > 0 ? lines[i - 1] : ''} ${lines[i]}`.trim().slice(0, 400);
                        if (context !== '' && !token.lines.includes(context)) {
                            token.lines.push(context);
                        }
                    }
                }
            }
        }
    });

    // 「反思维链」条目：
    //   a) 名字里就写着卡原生/禁用/🈲…
    //   b) 内容几乎只有闭合标记（≥2 个且一个开标记都没有）——典型的收尾预填充
    //   c) 带 `<|no-trans|>` 这类压制标记
    // 注意不要用「闭合比开多」这种松条件，真实预设里正常条目也会出现闭合偏多
    for (const meta of chunkMeta) {
        meta.anti = meta.antiByName
            || (meta.closes >= 2 && meta.opens === 0)
            || NO_TRANS_PATTERN.test(meta.text ?? '');
    }

    return { tokens: [...tokens.values()], chunkMeta };
}

/** 该 token 是否只出现在「反思维链」条目里（是的话整个丢弃） */
function onlyInAntiChunks(token, chunkMeta) {
    const indexes = [...token.presences.keys()];
    return indexes.length > 0 && indexes.every(index => chunkMeta[index]?.anti);
}

/** 该 token 是否出现在「思维链条目」里（只看非反思维链的条目），返回最高的相关度级别 */
function cotTierOfToken(token, chunkMeta) {
    let tier = 0;
    for (const index of token.presences.keys()) {
        const meta = chunkMeta[index];
        if (!meta || meta.anti) {
            continue;
        }
        tier = Math.max(tier, meta.cotTier ?? 0);
    }
    return tier;
}

/**
 * 为「只出现了开标记」的关键词标签找一个闭合标记。
 * 约束：必须在**同一条目**里、闭合标记在开标记**之后**、且括号风格兼容。
 */
function findKeywordClose(openToken, tokens, chunkMeta) {
    for (const token of tokens) {
        if (token.kind !== 'close' || token.name === openToken.name) {
            continue;
        }
        if (!THINKING_PATTERN.test(token.name) || onlyInAntiChunks(token, chunkMeta)) {
            continue;
        }
        if (token.style !== openToken.style && !isTerminatorName(token.name)) {
            continue;
        }
        for (const [chunkIndex, openOffset] of openToken.presences) {
            if (chunkMeta[chunkIndex]?.anti) {
                continue;
            }
            const closeOffset = token.presences.get(chunkIndex);
            if (closeOffset !== undefined && closeOffset > openOffset) {
                return token;
            }
        }
    }
    return null;
}

/**
 * 开标记与闭合标记被拆在**两个不同**的思维链条目里时的配对（如智脑-Z：
 * 「思维链动态开场」里是 `<脑内会议>`，「思维链收尾」里是 `</脑内会议>`）。
 * 要求两边都落在思维链相关且非反思维链的条目里。
 */
function findCrossEntryClose(openToken, byText, chunkMeta) {
    const openTier = cotTierOfToken(openToken, chunkMeta);
    if (openTier === 0) {
        return null;
    }
    const closeToken = byText.get(symmetricCloseText(openToken));
    if (!closeToken || closeToken.kind !== 'close' || onlyInAntiChunks(closeToken, chunkMeta)) {
        return null;
    }
    return cotTierOfToken(closeToken, chunkMeta) > 0 ? closeToken : null;
}

function symmetricCloseText(openToken) {
    return `${openToken.style}/${openToken.name}${TAG_STYLES[openToken.styleIndex].right}`;
}

function blocklisted(name) {
    return STRUCTURAL_TAG_BLOCKLIST.includes(String(name).trim().toLowerCase());
}

/**
 * 从「该标签出现的行（含上一行）」里找「把思考包在 X 里」这类说明。
 * 判断措辞前必须剥掉**标签本身**与 **STscript 宏**：
 * 否则 `<acg_think_format>` 或 `{{setvar::acg_think_format::` 里的 `format` / `think`
 * 会被自己当成「格式 + 思维链说明」，造成误判（真实踩过）。
 */
function instructionEvidence(token) {
    for (const line of token.lines) {
        const prose = String(line)
            .replace(/\{\{[^}\n]{0,200}?\}\}/g, ' ')   // 完整宏，如 {{char}}
            .replace(/\{\{[^\n]*$/g, ' ')              // 行内未闭合的 {{，如 {{setvar::x::
            .replace(/<\|?[^<>\n]{1,40}\|?>/g, ' ')
            .replace(/[【「『\[{][^【「『\]}\n]{1,40}[】」』\]}]/g, ' ');
        if (WRAP_CUE_PATTERN.test(prose) && THINKING_PATTERN.test(prose)) {
            return line;
        }
    }
    return '';
}

function scoreCandidate(candidate) {
    let score = 0;
    if (candidate.cotTier > 0) {
        score += 55 + candidate.cotTier * 5;
    }
    if (candidate.keyword) {
        score += 100;
    }
    if (candidate.instruction) {
        score += 60;
    }
    score += Math.min(candidate.count, 6) * 2;
    if (candidate.pairing === 'symmetric') {
        score += 10;
    }
    if (candidate.pairing === 'cross-entry') {
        score += 6;
    }
    if (candidate.pairing === 'synthesized') {
        score -= 40;
    }
    if (candidate.blocklisted) {
        score -= 80;
    }
    if (FORMAT_SHELL_PATTERN.test(candidate.tagName)) {
        score -= 120;
    }
    if (candidate.tagName.length > 16) {
        score -= 10;
    }
    // 条目是否在当前 prompt_order 里启用：启用的更可信，但**不作为硬过滤**
    // （有些预设把格式定义写在「多选一」的条目里，用户可能刚切换过）
    if (candidate.enabledEntry) {
        score += 12;
    } else if (candidate.disabledOnly) {
        score -= 12;
    }
    return score;
}

/**
 * 判断候选在当前模式下是否可以用来改设置。
 * safe 模式宁可不动：
 *   - 思维链条目里的**开闭成对**标签直接用（预设自己明说了这条是思维链）
 *   - 其它条目：只认关键词标签或「有明确包裹说明」的成对标签
 */
export function isApplicable(candidate, mode = 'safe') {
    if (!candidate || candidate.blocklisted) {
        return false;
    }
    if (mode === 'aggressive') {
        return true;
    }
    const paired = candidate.pairing === 'symmetric' || candidate.pairing === 'cross-entry';
    if (candidate.cotEntry && paired) {
        return true;
    }
    if (paired && (candidate.keyword || candidate.instruction)) {
        return true;
    }
    if (candidate.keyword && candidate.pairing === 'keyword') {
        return true;
    }
    return false;
}

/**
 * 从预设文本里推断思维链前后缀。
 *
 * 安全模式（默认）**只读思维链条目**，按可信度分档，取最高一档：
 *   1. 名字开头就是思维链词的条目（如「思维链动态开场」「📌 COT 接收」）且**已启用**
 *   2. 同上，但未标记启用状态
 *   3. 名字里含思维链词、主题不冲突的条目且已启用（如「📍常规创作思维」）
 *   4. 同上，但未标记启用状态
 *   5. 都没有时，才用「内容里明确写了『把思考包在 X 里』」的条目
 * 被排除的：反思维链条目（卡原生/禁用/收尾型预填充）、主题是开关/格式/状态栏/世界书/
 * 内心话的条目、`_format` 外壳、STscript 宏、结构性标签。
 * 宽松模式才看全量候选（可能选到这些干扰项，仅供排查）。
 * @param {{source?: string, text?: string, name?: string, identifier?: string, enabled?: boolean}[]} chunks
 * @param {{mode?: 'safe'|'aggressive', limit?: number}} [options]
 * @returns {{candidates: object[], ignoredCandidates: object[], ignoredCount: number, best: object|null, cotCandidateCount: number, tier: number, pool: string}}
 */
export function detectReasoningTags(chunks, { mode = 'safe', limit = 10 } = {}) {
    const list = Array.isArray(chunks) ? chunks : [];
    const { tokens, chunkMeta } = tokenize(list);
    const byText = new Map(tokens.map(token => [token.text, token]));
    const candidates = [];
    const seen = new Set();

    for (const openToken of tokens) {
        if (openToken.kind !== 'open' || onlyInAntiChunks(openToken, chunkMeta)) {
            continue;
        }

        const openChunks = [...openToken.presences.keys()].filter(index => !chunkMeta[index]?.anti);
        const cotTier = cotTierOfToken(openToken, chunkMeta);
        // 启用状态只看真正的提示词条目（预设级字段的 enabled 是 undefined，不算「未启用」）
        const promptChunks = openChunks.filter(index => typeof chunkMeta[index]?.enabled === 'boolean');
        const enabledEntry = promptChunks.some(index => chunkMeta[index].enabled === true);
        const disabledOnly = promptChunks.length > 0 && promptChunks.every(index => chunkMeta[index].enabled === false);
        const sources = [...new Set(openChunks.map(index => chunkMeta[index]?.source || chunkMeta[index]?.name).filter(Boolean))].slice(0, 3);

        const keyword = THINKING_PATTERN.test(openToken.name);
        const instruction = instructionEvidence(openToken);
        const closeText = symmetricCloseText(openToken);
        const symmetricToken = byText.get(closeText);

        const add = (suffix, pairing) => {
            const key = `${openToken.text}\u0000${suffix}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            const candidate = {
                prefix: openToken.text,
                suffix,
                tagName: openToken.name,
                pairing,
                count: openToken.count,
                keyword,
                instruction: instruction !== '',
                blocklisted: blocklisted(openToken.name),
                cotEntry: cotTier > 0,
                cotTier,
                enabledEntry,
                disabledOnly,
                sources,
                evidence: instruction || openToken.lines[0] || '',
            };
            candidate.score = scoreCandidate(candidate);
            candidates.push(candidate);
        };

        if (symmetricToken && !onlyInAntiChunks(symmetricToken, chunkMeta)) {
            add(symmetricToken.text, 'symmetric');
        } else {
            // 开闭标记被拆到两个思维链条目里（如「思维链动态开场」开、「思维链收尾」合）：
            // 只要两边都在思维链条目里，也认
            const crossClose = findCrossEntryClose(openToken, byText, chunkMeta);
            if (crossClose) {
                add(crossClose.text, 'cross-entry');
            } else if (keyword) {
                const keywordClose = findKeywordClose(openToken, tokens, chunkMeta);
                if (keywordClose) {
                    add(keywordClose.text, 'keyword');
                } else if (SYNTHESIZABLE_STYLES.has(openToken.style)) {
                    add(closeText, 'synthesized');
                }
            }
        }
    }

    candidates.sort((a, b) => b.score - a.score || a.tagName.length - b.tagName.length || b.count - a.count);

    // 安全模式：按可信度分档，取最高一档（同一档内再按得分排序）
    const instructed = candidates.filter(candidate => candidate.cotTier === 0 && candidate.instruction);
    const groups = [
        { tier: 4, pool: candidates.filter(c => c.cotTier === 3 && !c.disabledOnly), kind: 'cot-primary' },
        { tier: 3, pool: candidates.filter(c => c.cotTier === 3), kind: 'cot-primary-any' },
        { tier: 2, pool: candidates.filter(c => c.cotTier === 2 && !c.disabledOnly), kind: 'cot-secondary' },
        { tier: 1, pool: candidates.filter(c => c.cotTier === 2), kind: 'cot-secondary-any' },
        { tier: 0, pool: instructed, kind: 'instruction' },
    ];

    let pool = candidates;
    let poolKind = 'all';
    let tier = -1;
    if (mode !== 'aggressive') {
        const group = groups.find(item => item.pool.length > 0);
        if (group) {
            pool = group.pool;
            poolKind = group.kind;
            tier = group.tier;
        } else {
            pool = [];
            poolKind = 'empty';
            tier = -1;
        }
    }

    const poolSet = new Set(pool);
    const ignoredCandidates = candidates.filter(candidate => !poolSet.has(candidate));
    const best = pool.find(candidate => isApplicable(candidate, mode)) ?? null;

    return {
        candidates: pool.slice(0, limit),
        ignoredCandidates: ignoredCandidates.slice(0, limit),
        ignoredCount: ignoredCandidates.length,
        best,
        cotCandidateCount: candidates.filter(candidate => candidate.cotTier > 0).length,
        pool: poolKind,
        tier,
    };
}

/**
 * 思维链标签在正则里出现的迹象（用于判断这条正则是不是在「处理思维链的显示」）。
 * 不含 内心 / inner —— 那是给玩家看的展示内容，与推理解析不冲突。
 */
const COT_TAG_IN_REGEX_PATTERN = /(think|thought|reason|cot|story[_\s-]?driver|brain|脑内|思考|推理|思维|ecot)/i;

/** 替换内容像「美化」的样子：HTML 标签 / 内联样式 */
const DECORATIVE_REPLACE_PATTERN = /<\/?(?:div|span|details|summary|b|i|u|em|strong|font|small|center|table|tr|td|th|p|br|hr|blockquote|code|pre|style|body)\b|class\s*=|style\s*=|background|border|border-radius|font-size|color\s*:/i;

/**
 * 找出预设里「自己处理思维链显示」的正则脚本（美化或隐藏）。
 *
 * 这类脚本跑在 AI_OUTPUT 阶段，**需要消息里还留着原始思维链文本**；
 * 一旦 ST 的「自动解析」把推理块抽进推理区（流式阶段就抽走了），正则就再也看不到它，美化/隐藏都会失效。
 * 所以检测到它们时应当自动关掉自动解析。
 *
 * 判据：脚本启用 + 作用在 AI 输出（placement 含 2/AI_OUTPUT）+ 不是 promptOnly +
 *      findRegex 里点名了思维链类标签 + 替换内容要么「美化」（HTML/样式）要么「清空」（隐藏）。
 *
 * @param {{scriptName?: string, findRegex?: string, replaceString?: string, placement?: number[]|number, disabled?: boolean, promptOnly?: boolean}[]} scripts
 * @returns {{scriptName: string, kind: 'beautify'|'hide'}[]}
 */
export function findCotDisplayScripts(scripts) {
    if (!Array.isArray(scripts)) {
        return [];
    }
    const found = [];
    for (const script of scripts) {
        if (!script || typeof script !== 'object' || script.disabled === true || script.promptOnly === true) {
            continue;
        }
        const placement = Array.isArray(script.placement) ? script.placement : [script.placement];
        const isAiOutput = placement.some(item => Number(item) === 2 || String(item).toUpperCase() === 'AI_OUTPUT');
        if (!isAiOutput) {
            continue;
        }
        const find = String(script.findRegex ?? '');
        if (find === '' || !COT_TAG_IN_REGEX_PATTERN.test(find)) {
            continue;
        }
        const replace = String(script.replaceString ?? '');
        const kind = replace.trim() === ''
            ? 'hide'
            : (DECORATIVE_REPLACE_PATTERN.test(replace) ? 'beautify' : null);
        if (!kind) {
            continue;
        }
        found.push({ scriptName: String(script.scriptName ?? '(未命名)'), kind });
    }
    return found;
}

/**
 * 一行文字描述识别结果，用于状态栏与报告面板。
 * @param {object} candidate
 */
export function describeCandidate(candidate) {
    if (!candidate) {
        return '无候选';
    }
    const pairingLabel = {
        symmetric: '开闭成对',
        'cross-entry': '开闭在同属思维链的两个条目里',
        keyword: '由关键词闭合标记配对',
        synthesized: '仅见开标记，闭合标签为推断值',
    }[candidate.pairing] ?? candidate.pairing;
    const flags = [
        candidate.cotTier === 3 ? '来自思维链主条目' : (candidate.cotEntry ? '来自思维链条目' : null),
        candidate.keyword ? '标签名含思维链关键词' : null,
        candidate.instruction ? '预设里写明包裹方式' : null,
        candidate.disabledOnly ? '所属条目当前未启用' : null,
    ].filter(Boolean);
    return [
        `前缀 ${JSON.stringify(candidate.prefix)}`,
        `后缀 ${JSON.stringify(candidate.suffix)}`,
        pairingLabel,
        `出现 ${candidate.count} 次`,
        `得分 ${candidate.score}`,
        flags.length ? flags.join(' + ') : '无强证据',
    ].join(' ｜ ');
}
