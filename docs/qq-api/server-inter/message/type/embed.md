<!-- source: https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/embed.html -->

#  Embed 消息

|  | 单聊 | 群聊 | 文字子频道 | 频道私信 |

| 机器人接收 | - | - | - | - |

| 机器人发送 | 不支持 | 不支持 | 支持 | 支持 |

##  样式

![img](https://qq-ai.cdn-go.cn/web/bot-docs/-/v1.30.1/assets/img/me)

##  数据结构与协议

###  Content-Type

```
application/json

```

1

###  参数

| 字段名 | 类型 | 描述 |

| embed | MessageEmbed | embed 消息详情 |

- 其中 embed.thumbnail 为选填，没有缩略图的可以不填。

- embed.fields.name 为文本。

###  返回

返回Message对象。

###  错误码

详见错误码。

###  示例

请求数据包

```
{
  "embed": {
    "title": "标题",
    "prompt": "消息通知",
    "thumbnail": {
      "url": "xxxxxx"
    },
    "fields": [
      {
        "name": "当前等级：黄金"
      },
      {
        "name": "之前等级：白银"
      },
      {
        "name": "😁继续努力"
      }
    ]
  }
}

```

1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20

返回包

```
{
  "id": "xxxxxx",
  "channel_id": "xxxxxx",
  "guild_id": "xxxxxx",
  "timestamp": "2021-12-07T15:24:54+08:00",
  "tts": false,
  "mention_everyone": false,
  "author": {
    "id": "xxxxxx",
    "username": "abc",
    "avatar": "",
    "bot": true
  },
  "embeds": [
    {
      "title": "标题",
      "prompt": "xxxx",
      "description": "",
      "thumbnail": {
        "url": "xxxxxx"
      },
      "fields": [
        {
          "name": "当前等级：黄金"
        },
        {
          "name": "之前等级：白银"
        },
        {
          "name": "😁继续努力"
        }
      ]
    }
  ],
  "pinned": false,
  "type": 0,
  "flags": 0
}

```

1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
30
31
32
33
34
35
36
37
38
