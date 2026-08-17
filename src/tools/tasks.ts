import { randomUUID } from 'node:crypto';
import { logger } from '../logging/logger';
import type { ShellPolicy, ShellRequest, ShellResult } from './types';
import { executeShell } from './executor';

const log = logger.child('shell-tasks');

export interface ShellTaskOwner {
  senderId: number;
  chatId: string;
  groupId?: number;
}

export interface ShellTask {
  taskId: string;
  owner: ShellTaskOwner;
  request: ShellRequest;
  requestId?: string;
  startedAt: number;
  stopRequested: boolean;
  controller: AbortController;
}

export interface ShellTaskFinished {
  task: ShellTask;
  result?: ShellResult;
  decision: Awaited<ReturnType<typeof executeShell>>['decision'];
  requestId: string;
  error?: unknown;
}

/** 进程任务表：只保存运行中的任务，避免阻塞 OneBot 事件处理。 */
export class ShellTaskManager {
  private readonly tasks = new Map<string, ShellTask>();

  list(chatId?: string): ShellTask[] {
    return [...this.tasks.values()].filter((task) => chatId === undefined || task.owner.chatId === chatId);
  }

  get(taskId: string): ShellTask | undefined {
    return this.tasks.get(taskId);
  }

  start(
    request: ShellRequest,
    owner: ShellTaskOwner,
    policy: ShellPolicy,
    onFinished: (finished: ShellTaskFinished) => Promise<void> | void,
  ): ShellTask {
    const task: ShellTask = {
      taskId: randomUUID().slice(0, 8),
      owner,
      request,
      startedAt: Date.now(),
      stopRequested: false,
      controller: new AbortController(),
    };
    this.tasks.set(task.taskId, task);
    void (async () => {
      let finished: ShellTaskFinished;
      try {
        const execution = await executeShell(request, policy, owner.senderId, task.controller.signal);
        task.requestId = execution.requestId;
        finished = { task, result: execution.result, decision: execution.decision, requestId: execution.requestId };
      } catch (error) {
        finished = {
          task,
          decision: { allowed: false, reason: '执行器异常' },
          requestId: task.requestId ?? randomUUID(),
          error,
        };
      }
      try {
        await onFinished(finished);
      } catch (error) {
        // 回复通道失败不应形成未处理 rejection，也不能让任务残留在表中。
        log.error('shell 任务完成回调失败', { err: error instanceof Error ? error.message : String(error) });
      } finally {
        this.tasks.delete(task.taskId);
      }
    })();
    return task;
  }

  stop(task: ShellTask): void {
    task.stopRequested = true;
    task.controller.abort();
  }

  stopMatching(chatId: string, taskId: string | undefined, actorId: number, adminIds: number[]): ShellTask[] {
    const isAdmin = adminIds.includes(actorId);
    const matched = this.list(chatId).filter((task) => taskId === undefined || task.taskId === taskId);
    const allowed = matched.filter((task) => isAdmin || task.owner.senderId === actorId);
    for (const task of allowed) this.stop(task);
    return allowed;
  }
}

export const shellTasks = new ShellTaskManager();
