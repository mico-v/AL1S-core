<!-- source: https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/pins/put_pins_message.html -->

#  添加精华消息

##  接口

```
PUT /channels/{channel_id}/pins/{message_id}

```

1

##  功能描述

用于添加子频道 `channel_id` 内的精华消息。

- 精华消息在一个子频道内最多只能创建 `20` 条。

- 只有可见的消息才能被设置为精华消息。

- 接口返回对象中 `message_ids` 为当前请求后子频道内所有精华消息 `message_id` 数组。

##  Content-Type

```
application/json

```

1

##  返回

返回 PinsMessage 对象。

##  错误码

详见错误码。

##  示例

请求数据包

```
PUT /channels/123456/pins/112233

```

1

响应数据包

```
{
  "guild_id": "xxxxxx",
  "channel_id": "xxxxxx",
  "message_ids": ["xxxxx"]
}

```

1
2
3
4
5
