// 容器健康检查：
//  - 配置了 ADMIN_TOKEN：探测管理后台端口（默认 6185）TCP 连通性；
//  - 未配置 ADMIN_TOKEN（管理服务不启动）：视为健康（进程活着即可）。
import net from 'node:net';

const token = process.env.ADMIN_TOKEN;
if (!token || token.trim() === '') process.exit(0);

const port = Number(process.env.ADMIN_PORT ?? 6185);
const sock = net.connect({ host: '127.0.0.1', port }, () => {
  sock.destroy();
  process.exit(0);
});
sock.on('error', () => process.exit(1));