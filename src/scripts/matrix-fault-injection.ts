/**
 * `tuwunel-check` 专用故障夹具。
 *
 * 只有显式设置 `MATRIX_BRIDGE_TEST_FAULT` 并通过 `--import` 预加载时才会
 * 注册 SIGUSR2 处理器；生产入口本身不包含测试开关。
 */

const fault = process.env['MATRIX_BRIDGE_TEST_FAULT'];
if (fault === 'uncaughtException' || fault === 'unhandledRejection') {
  process.once('SIGUSR2', () => {
    const error = new Error(`injected ${fault}`);
    if (fault === 'uncaughtException') {
      throw error;
    }
    void Promise.reject(error);
  });
}
