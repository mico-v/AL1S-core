/**
 * QQ Matrix bridge 部署前配置校验。
 *
 * registration 模板只使用受控的 YAML 子集；这里显式解析所需字段，
 * 避免为了部署检查引入额外运行时依赖。
 */

import { deriveGhostLocalpart } from '../bridge/bridge.js';
import type { MatrixBridgeConfig } from '../config.js';

export interface RegistrationNamespace {
  exclusive: boolean;
  regex: string;
}

export interface AppserviceRegistration {
  id: string;
  url: string;
  asToken: string;
  hsToken: string;
  senderLocalpart: string;
  receiveEphemeral: boolean;
  users: RegistrationNamespace[];
  aliases: RegistrationNamespace[];
}

export interface DeploymentValidationResult {
  errors: string[];
  warnings: string[];
}

export interface DeploymentValidationOptions {
  config: MatrixBridgeConfig;
  registration: AppserviceRegistration;
  expectedBridgeUrl: string;
}

export class RegistrationParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationParseError';
  }
}

type Scalar = string | boolean;

interface NamespaceBuilder {
  exclusive?: boolean;
  regex?: string;
}

function stripComment(line: string): string {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (doubleQuoted) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }
    if (singleQuoted) {
      if (character === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (character === "'") {
      singleQuoted = true;
    } else if (character === '"') {
      doubleQuoted = true;
    } else if (
      character === '#' &&
      (index === 0 || /\s/.test(line[index - 1] ?? ''))
    ) {
      return line.slice(0, index);
    }
  }

  if (singleQuoted || doubleQuoted) {
    throw new RegistrationParseError('registration 包含未闭合的引号');
  }
  return line;
}

function parseScalar(value: string, lineNumber: number): Scalar {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new RegistrationParseError(`registration 第 ${String(lineNumber)} 行引号不完整`);
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed !== 'string') {
        throw new Error('not a string');
      }
      return parsed;
    } catch {
      throw new RegistrationParseError(`registration 第 ${String(lineNumber)} 行双引号字符串无效`);
    }
  }
  return value;
}

function parseMapping(
  text: string,
  lineNumber: number,
): { key: string; value: Scalar | '' } {
  const separator = text.indexOf(':');
  if (separator <= 0) {
    throw new RegistrationParseError(`registration 第 ${String(lineNumber)} 行不是键值对`);
  }
  const key = text.slice(0, separator).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new RegistrationParseError(`registration 第 ${String(lineNumber)} 行键名无效`);
  }
  const rawValue = text.slice(separator + 1).trim();
  return {
    key,
    value: rawValue === '' ? '' : parseScalar(rawValue, lineNumber),
  };
}

function requireString(value: Scalar | '' | undefined, key: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new RegistrationParseError(`registration 缺少非空字段 ${key}`);
  }
  return value;
}

export function parseAppserviceRegistration(source: string): AppserviceRegistration {
  const topLevel = new Map<string, Scalar>();
  const namespaces: Record<'users' | 'aliases', RegistrationNamespace[]> = {
    users: [],
    aliases: [],
  };
  let topLevelKey: string | undefined;
  let namespaceKey: 'users' | 'aliases' | undefined;
  let currentNamespace: NamespaceBuilder | undefined;

  const finishNamespace = (): void => {
    if (currentNamespace === undefined) {
      return;
    }
    if (
      typeof currentNamespace.exclusive !== 'boolean' ||
      typeof currentNamespace.regex !== 'string'
    ) {
      throw new RegistrationParseError('registration namespace 缺少 exclusive 或 regex');
    }
    if (namespaceKey !== undefined) {
      namespaces[namespaceKey].push({
        exclusive: currentNamespace.exclusive,
        regex: currentNamespace.regex,
      });
    }
    currentNamespace = undefined;
  };

  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    const lineNumber = index + 1;
    if (/^\s*\t/.test(rawLine)) {
      throw new RegistrationParseError(`registration 第 ${String(lineNumber)} 行使用 Tab 缩进`);
    }
    const withoutComment = stripComment(rawLine);
    const content = withoutComment.trimEnd();
    if (content.trim() === '') {
      continue;
    }
    const indent = content.length - content.trimStart().length;
    const text = content.trimStart();

    if (indent === 0) {
      finishNamespace();
      namespaceKey = undefined;
      const mapping = parseMapping(text, lineNumber);
      topLevelKey = mapping.key;
      if (mapping.key === 'namespaces') {
        if (mapping.value !== '') {
          throw new RegistrationParseError('registration namespaces 必须是嵌套结构');
        }
        continue;
      }
      if (mapping.value !== '') {
        topLevel.set(mapping.key, mapping.value);
      }
      continue;
    }

    if (topLevelKey !== 'namespaces') {
      continue;
    }

    if (indent === 2) {
      finishNamespace();
      namespaceKey = undefined;
      const mapping = parseMapping(text, lineNumber);
      if (mapping.key !== 'users' && mapping.key !== 'aliases') {
        continue;
      }
      if (mapping.value !== '' && mapping.value !== '[]') {
        throw new RegistrationParseError(
          `registration namespaces.${mapping.key} 必须是嵌套列表`,
        );
      }
      if (mapping.value !== '[]') {
        namespaceKey = mapping.key;
      }
      continue;
    }

    if (namespaceKey === undefined || indent < 4) {
      continue;
    }

    let entryText = text;
    if (entryText.startsWith('- ')) {
      finishNamespace();
      currentNamespace = {};
      entryText = entryText.slice(2).trim();
      if (entryText === '') {
        continue;
      }
    }
    if (currentNamespace === undefined) {
      throw new RegistrationParseError(
        `registration 第 ${String(lineNumber)} 行 namespace 条目缺少 "-"`,
      );
    }
    const mapping = parseMapping(entryText, lineNumber);
    if (mapping.key === 'exclusive') {
      if (typeof mapping.value !== 'boolean') {
        throw new RegistrationParseError('registration namespace exclusive 必须是布尔值');
      }
      currentNamespace.exclusive = mapping.value;
    } else if (mapping.key === 'regex') {
      if (typeof mapping.value !== 'string' || mapping.value === '') {
        throw new RegistrationParseError('registration namespace regex 必须是非空字符串');
      }
      currentNamespace.regex = mapping.value;
    }
  }
  finishNamespace();

  const receiveEphemeral = topLevel.get('receive_ephemeral');
  if (typeof receiveEphemeral !== 'boolean') {
    throw new RegistrationParseError('registration 缺少布尔字段 receive_ephemeral');
  }

  return {
    id: requireString(topLevel.get('id'), 'id'),
    url: requireString(topLevel.get('url'), 'url'),
    asToken: requireString(topLevel.get('as_token'), 'as_token'),
    hsToken: requireString(topLevel.get('hs_token'), 'hs_token'),
    senderLocalpart: requireString(topLevel.get('sender_localpart'), 'sender_localpart'),
    receiveEphemeral,
    users: namespaces.users,
    aliases: namespaces.aliases,
  };
}

function normalizeUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = '';
  return parsed.href.replace(/\/$/, '');
}

function secretProblem(value: string): string | undefined {
  if (value.length < 32) {
    return '长度不足 32';
  }
  if (/(change|example|placeholder|replace|sample)/i.test(value)) {
    return '仍为模板值';
  }
  return undefined;
}

function namespaceMatches(
  namespaces: RegistrationNamespace[],
  value: string,
  label: string,
  errors: string[],
): boolean {
  const exclusive = namespaces.filter((namespace) => namespace.exclusive);
  if (exclusive.length === 0) {
    errors.push(`registration 缺少 exclusive ${label} namespace`);
    return false;
  }

  let matched = false;
  for (const namespace of exclusive) {
    try {
      if (new RegExp(namespace.regex).test(value)) {
        matched = true;
      }
    } catch {
      errors.push(`registration ${label} namespace 正则无效`);
    }
  }
  if (!matched) {
    errors.push(`registration exclusive ${label} namespace 不匹配 bridge 生成的标识`);
  }
  return matched;
}

export function validateDeploymentConfig(
  options: DeploymentValidationOptions,
): DeploymentValidationResult {
  const { config, registration } = options;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (registration.id !== config.id) {
    errors.push('registration id 与 MATRIX_BRIDGE_ID 不一致');
  }
  if (registration.senderLocalpart !== config.senderLocalpart) {
    errors.push('registration sender_localpart 与 MATRIX_BRIDGE_SENDER_LOCALPART 不一致');
  }
  if (registration.asToken !== config.asToken) {
    errors.push('registration as_token 与 MATRIX_BRIDGE_AS_TOKEN 不一致');
  }
  if (registration.hsToken !== config.hsToken) {
    errors.push('registration hs_token 与 MATRIX_BRIDGE_HS_TOKEN 不一致');
  }
  if (registration.receiveEphemeral) {
    errors.push('registration receive_ephemeral 必须为 false');
  }

  try {
    if (normalizeUrl(registration.url) !== normalizeUrl(options.expectedBridgeUrl)) {
      errors.push('registration url 与当前部署模式预期的 bridge 地址不一致');
    }
  } catch {
    errors.push('registration url 不是合法 URL');
  }

  const asProblem = secretProblem(config.asToken);
  const hsProblem = secretProblem(config.hsToken);
  if (asProblem !== undefined) {
    errors.push(`MATRIX_BRIDGE_AS_TOKEN ${asProblem}`);
  }
  if (hsProblem !== undefined) {
    errors.push(`MATRIX_BRIDGE_HS_TOKEN ${hsProblem}`);
  }
  if (config.asToken === config.hsToken) {
    errors.push('MATRIX_BRIDGE_AS_TOKEN 与 MATRIX_BRIDGE_HS_TOKEN 必须不同');
  }
  if (config.identitySecret.length < 32) {
    warnings.push('MATRIX_BRIDGE_IDENTITY_SECRET 建议至少 32 字符');
  }
  if (/^(?:matrix\.)?example(?:\.com)?$/i.test(config.domain)) {
    errors.push('MATRIX_BRIDGE_DOMAIN 仍为示例域名');
  }

  const ghostLocalpart = deriveGhostLocalpart(
    config.identitySecret,
    'deployment-preflight',
    config.userPrefix,
  );
  const aliasLocalpart = deriveGhostLocalpart(
    config.identitySecret,
    'deployment-preflight-alias',
    config.aliasPrefix,
  );
  namespaceMatches(
    registration.users,
    `@${ghostLocalpart}:${config.domain}`,
    'users',
    errors,
  );
  namespaceMatches(
    registration.aliases,
    `#${aliasLocalpart}:${config.domain}`,
    'aliases',
    errors,
  );

  if (config.allowedSenders.length === 0) {
    warnings.push('MATRIX_BRIDGE_ALLOWED_SENDERS 为空，Matrix 到 QQ 将全部拒绝');
  } else if (config.allowedSenders.includes('*')) {
    warnings.push('MATRIX_BRIDGE_ALLOWED_SENDERS 包含 *，请确认房间级授权策略符合预期');
  }

  return { errors, warnings };
}
