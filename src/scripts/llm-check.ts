/**
 * LLM 冒烟脚本：不连 QQ，直接调一次 LLM 验证 provider 流式通路。
 * 未配置 LLM_API_KEY 时打印跳过提示并正常退出。
 *
 * 用法：npm run llm:check
 */
import { loadConfig } from '../config';
import { OpenAIProvider } from '../llm/openai';
import { logger } from '../logging/logger';

const log = logger.child('llm-check');
const config = loadConfig();

// 本地无 key 时跳过（不视为失败）
if (!config.llm.apiKey) {
  log.info('跳过：未配置 LLM_API_KEY');
  process.exit(0);
}

const provider = new OpenAIProvider({
  baseUrl: config.llm.baseUrl,
  apiKey: config.llm.apiKey,
  model: config.llm.model,
});

let gotDone = false;

for await (const event of provider.streamChat({
  messages: [{ role: 'user', content: '你好，用一句话介绍你自己。' }],
  temperature: config.llm.temperature,
  maxTokens: config.llm.maxTokens,
})) {
  if (event.type === 'text') {
    process.stdout.write(event.delta);
  } else if (event.type === 'done') {
    gotDone = true;
    if (event.error) {
      log.error('LLM 返回错误', { err: event.error });
      process.exit(1);
    }
    log.info('LLM 冒烟测试通过');
    process.exit(0);
  }
}

// 防御：流结束但没收到 done
if (!gotDone) {
  log.error('失败：流结束但未收到 done 事件');
  process.exit(1);
}
