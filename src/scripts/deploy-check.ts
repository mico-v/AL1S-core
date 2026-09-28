/**
 * 生产部署前检查 registration、.env 与运行模式的一致性。
 *
 * 默认读取 deploy/appservice.yaml 和 .env，并按 Compose 内部服务名
 * 校验 registration URL。宿主机进程部署使用 `--mode host`。
 *
 * 运行：pnpm deploy:check [-- --mode compose|host]
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigError, loadConfig } from '../config.js';
import {
  RegistrationParseError,
  parseAppserviceRegistration,
  validateDeploymentConfig,
} from '../deploy/preflight.js';

type DeploymentMode = 'compose' | 'host';

interface Options {
  envPath: string;
  registrationPath: string;
  mode: DeploymentMode;
  bridgeUrl?: string;
}

function usage(): string {
  return [
    '用法：pnpm deploy:check [-- options]',
    '',
    '选项：',
    '  --env <path>          环境文件，默认 .env',
    '  --registration <path> registration 文件，默认 deploy/appservice.yaml',
    '  --mode <compose|host> 部署模式，默认 compose',
    '  --bridge-url <url>    显式覆盖 registration 中预期的 bridge URL',
    '  --help                显示帮助',
  ].join('\n');
}

function parseArgs(args: string[]): Options | undefined {
  const options: Options = {
    envPath: '.env',
    registrationPath: 'deploy/appservice.yaml',
    mode: 'compose',
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      return undefined;
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`缺少 ${argument ?? ''} 的参数值`);
    }
    if (argument === '--env') {
      options.envPath = value;
    } else if (argument === '--registration') {
      options.registrationPath = value;
    } else if (argument === '--mode') {
      if (value !== 'compose' && value !== 'host') {
        throw new Error('--mode 只支持 compose 或 host');
      }
      options.mode = value;
    } else if (argument === '--bridge-url') {
      options.bridgeUrl = value;
    } else {
      throw new Error(`未知参数：${argument ?? ''}`);
    }
    index += 1;
  }
  return options;
}

function checkPrivateFile(path: string, label: string, errors: string[], checks: string[]): void {
  let mode: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      errors.push(`${label} 不是普通文件`);
      return;
    }
    mode = stat.mode & 0o777;
  } catch {
    errors.push(`找不到 ${label}：${path}`);
    return;
  }

  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    errors.push(`${label} 权限过宽（当前 ${mode.toString(8)}），应设置为 600`);
    return;
  }
  checks.push(`${label} 权限仅所有者可访问`);
}

function expectedBridgeUrl(options: Options, port: number): string {
  if (options.bridgeUrl !== undefined) {
    return options.bridgeUrl;
  }
  if (options.mode === 'compose') {
    return `http://bridge:${String(port)}`;
  }
  return `http://127.0.0.1:${String(port)}`;
}

function printResult(checks: string[], warnings: string[], errors: string[]): void {
  for (const item of checks) {
    console.log(`  ✓ ${item}`);
  }
  for (const item of warnings) {
    console.warn(`  ! ${item}`);
  }
  for (const item of errors) {
    console.error(`  ✗ ${item}`);
  }
}

async function main(): Promise<void> {
  let options: Options | undefined;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  if (options === undefined) {
    console.log(usage());
    return;
  }

  const envPath = resolve(options.envPath);
  const registrationPath = resolve(options.registrationPath);
  const checks: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  console.log('QQ Matrix bridge 部署前检查');
  checkPrivateFile(envPath, options.envPath, errors, checks);
  checkPrivateFile(registrationPath, options.registrationPath, errors, checks);
  if (errors.length > 0) {
    printResult(checks, warnings, errors);
    process.exitCode = 1;
    return;
  }

  try {
    const env = parseEnv(readFileSync(envPath, 'utf8'));
    const config = loadConfig(env).matrixBridge;
    if (config === undefined) {
      throw new ConfigError('MATRIX_BRIDGE_ENABLED 必须为 true');
    }
    const registration = parseAppserviceRegistration(readFileSync(registrationPath, 'utf8'));
    const result = validateDeploymentConfig({
      config,
      registration,
      expectedBridgeUrl: expectedBridgeUrl(options, config.listenPort),
    });
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    if (result.errors.length === 0) {
      checks.push('registration 与 .env 的身份、密钥和 namespace 配置一致');
      checks.push(`registration URL 符合 ${options.mode} 部署模式`);
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof RegistrationParseError) {
      errors.push(error.message);
    } else {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  printResult(checks, warnings, errors);
  if (errors.length > 0) {
    console.error(`\n部署前检查失败：${String(errors.length)} 项`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n部署前检查通过${warnings.length === 0 ? '' : `（${String(warnings.length)} 项警告）`}`);
}

await main();
