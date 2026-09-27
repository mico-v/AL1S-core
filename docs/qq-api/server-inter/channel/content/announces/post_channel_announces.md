<!-- source: https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/announces/post_channel_announces.html -->

#  创建子频道公告（2022年3月15日后废弃）

##  接口

```
POST /channels/{channel_id}/announces

```

1

##  功能描述

用于将子频道 `channel_id` 内的某条消息设置为子频道公告。

- 此接口在 APP `v8.8.65` 后不保证完全兼容并且2022年3月15日后会废弃，如需此功能请使用 添加精华消息

##  Content-Type

```
application/json

```

1

##  参数

| 字段名 | 类型 | 描述 |

| message_id | string | 消息 id |

##  返回

返回Announces 对象。

##  错误码

详见错误码。

##  示例

请求数据包

```
{
  "message_id": "xxxxxx"
}

```

1
2
3

响应数据包

```
{
  "guild_id": "xxxxxx",
  "channel_id": "xxxxxx",
  "message_id": "xxxxxx"
}

```

1
2
3
4
5
