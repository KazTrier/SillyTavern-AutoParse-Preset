/**
 * 桩：模拟 SillyTavern 的 public/scripts/preset-manager.js。
 * 只实现扩展用到的 getPresetManager('openai').getSelectedPresetName()。
 */

export const presetState = { selected: 'My Preset' };

export function getPresetManager(apiId = '') {
    return {
        getSelectedPresetName: () => (apiId === 'openai' ? presetState.selected : null),
    };
}
