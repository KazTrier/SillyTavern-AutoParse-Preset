/**
 * 桩：模拟 SillyTavern 的 public/scripts/openai.js 中被扩展用到的那部分。
 * 扩展通过 getChatCompletionPreset() 读取「当前聊天补全预设」的完整内容，
 * 通过 oai_settings.preset_settings_openai 读取预设名。
 */

export const oai_settings = {
    preset_settings_openai: 'My Preset',
    openai_model: 'gpt-4o',
};

/** 当前预设的正文（测试里可直接替换） */
export const openaiState = {
    preset: {
        prompts: [],
    },
};

export function getChatCompletionPreset() {
    return structuredClone(openaiState.preset);
}
