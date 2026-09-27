<!-- source: https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/pins/delete_pins_message.html -->

#  删除精华消息

##  接口

```
DELETE /channels/{channel_id}/pins/{message_id}

```

1

##  功能描述

用于删除子频道 `channel_id` 下指定 `message_id` 的精华消息。

- 删除子频道内全部精华消息，请将 `message_id` 设置为 `all`。

##  Content-Type

```
application/json

```

1

##  返回

成功返回 HTTP 状态码 `204`。

##  错误码

详见错误码。

##  示例

请求数据包

```
DELETE /channels/123456/pins/112233

```

1
