（自动续跑 {{round}}/{{max_rounds}}）接着推目标：{{objective}}

这一轮只做一片 —— {{slice}}。

你的活是**指挥与验收**，不是搬砖：需求拆成切片派给 NPC（cnb_issue_dispatch），验收看 PR 里 NPC 贴的输出 + ci_status / cnb pulls check-status，**别在本地跑全量测试与构建**（要复现只跑定向用例，几秒的那种）。

互不碰目录的片一次派 2~3 个并行跑，派完 goal_watch 挂探针。做完就 goal_step 标进度，全部验过再 goal_finish，卡住就 goal_block（同一卡点要连续 3 轮才允许停）。

{{notice}}
