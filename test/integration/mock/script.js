/**
 * 桩：模拟 SillyTavern 的 public/script.js 中被扩展用到的那部分。
 */

export const event_types = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    MAIN_API_CHANGED: 'main_api_changed',
    OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
    SETTINGS_LOADED_AFTER: 'settings_loaded_after',
};

const handlers = new Map();

export const eventSource = {
    on(type, callback) {
        if (!handlers.has(type)) {
            handlers.set(type, []);
        }
        handlers.get(type).push(callback);
    },
    emit(type, ...args) {
        for (const callback of handlers.get(type) ?? []) {
            callback(...args);
        }
    },
    listenerCount(type) {
        return (handlers.get(type) ?? []).length;
    },
};

export let main_api = 'openai';

export function __setMainApi(value) {
    main_api = value;
}

export const counters = { save: 0 };

export function saveSettingsDebounced() {
    counters.save += 1;
}
