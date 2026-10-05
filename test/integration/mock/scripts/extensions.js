/**
 * 桩：模拟 SillyTavern 的 public/scripts/extensions.js。
 * renderExtensionTemplateAsync 走真实的 settings.html 文件，保证模板路径与内容都被验证。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const extension_settings = {};

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const renderCalls = [];

export async function renderExtensionTemplateAsync(extensionName, templateId) {
    renderCalls.push({ extensionName, templateId });
    const folder = String(extensionName).replace(/^third-party\//, '');
    const file = path.join(HERE, 'extensions', 'third-party', folder, `${templateId}.html`);
    return fs.readFile(file, 'utf8');
}
