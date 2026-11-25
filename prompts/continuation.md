（自动续跑 {{round}}/{{max_rounds}}）接着推目标：{{objective}}

这一轮只做一片 —— {{slice}}。

你的活是**把这一片做成**：想明白怎么做、该改的代码自己改，或把需求拆清楚派给 NPC（cnb_issue_dispatch）并行推进；
验收看 PR 里 NPC 贴的输出 + ci_status / cnb pulls check-status，**全量测试与构建交给 CI 或 NPC**（本机只跑定向用例，几秒的那种）。

汇报讲实质：这轮把什么从「不能」变成了「能」、现象是什么、还差什么。别拿「CI 全绿」「已推送」当成果交差。

互不碰目录的片一次派 2~3 个并行跑，派完 goal_watch 挂探针。做完就 goal_step 标进度，全部验过再 goal_finish，卡住就 goal_block（同一卡点要连续 3 轮才允许停）。

{{notice}}
