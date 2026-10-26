---
name: napcat
description: 当在onebot平台时, 可用此技能发送消息, 管理群, 查找用户信息, 修改自身信息等功能, 可以用http工具或curl来调用
keywords: napcat, qq bot, send_private_msg, send_group_msg, 发送消息, qq消息, 群管理, onebot, go-cqhttp,  napcat api.
---

> **运行时注入**：`{{NAPCAT_BASE_URL}}` / `{{NAPCAT_TOKEN}}` 由插件在加载技能详情时替换（Token←`onebot.token`；Base←`aiChat.napcatHttpBase` 或环境变量 `NAPCAT_BASE_URL`，默认 `http://127.0.0.1:3005`）。禁止在技能正文写死公网 IP 或密钥。收附件走插件 fileMessage/`enableLocalFile2Url`；回复媒体标签仍用 `send-media`。

# NapCat QQ Bot HTTP API

Base URL: `{{NAPCAT_BASE_URL}}`
Token: `{{NAPCAT_TOKEN}}`

## Authentication

All requests must include the token via HTTP header or query parameter:

```
Authorization: Bearer {{NAPCAT_TOKEN}}
```

or append `?access_token={{NAPCAT_TOKEN}}` to the URL.

## API Call Format

All OneBot 11 action APIs are called via `POST /<action_name>` with JSON body.

```bash
curl -X POST "{{NAPCAT_BASE_URL}}/<action_name>" \
  -H "Authorization: Bearer {{NAPCAT_TOKEN}}" \
  -H "Content-Type: application/json" \
  -d '{...params...}'
```

## Response Format

```json
{
  "status": "ok",
  "retcode": 0,
  "data": { ... },
  "echo": "..."
}
```

On error:
```json
{
  "status": "failed",
  "retcode": 100,
  "message": "error description",
  "echo": "..."
}
```

---

## 1. Message APIs (消息)

### send_msg — Send message (universal)
POST `/send_msg`
```json
{
  "message_type": "private|group",
  "user_id": 123456789,
  "group_id": 987654321,
  "message": "hello" 
}
```
message supports CQ codes: `[CQ:image,file=xxx]`, `[CQ:at,qq=xxx]`, `[CQ:face,id=xxx]`, `[CQ:record,file=xxx]`, `[CQ:video,file=xxx]`, `[CQ:reply,id=xxx]`, etc.
JSON array format also supported: `[{"type":"text","data":{"text":"hello"}}]`

### send_private_msg — Send private message
POST `/send_private_msg`
```json
{"user_id": 123456789, "message": "hello"}
```

### send_group_msg — Send group message
POST `/send_group_msg`
```json
{"group_id": 987654321, "message": "hello"}
```

### delete_msg — Recall/delete a message
POST `/delete_msg`
```json
{"message_id": 123456}
```

### get_msg — Get a single message
POST `/get_msg`
```json
{"message_id": 123456}
```

### get_forward_msg — Get forward (merged) message
POST `/get_forward_msg`
```json
{"id": "forward_message_id"}
```

### send_forward_msg — Send forward message
POST `/send_forward_msg`
```json
{"messages": [...], "group_id": 123, "user_id": 456}
```

### send_group_forward_msg — Send group forward message
POST `/send_group_forward_msg`
```json
{"group_id": 987654321, "messages": [...]}
```

### send_private_forward_msg — Send private forward message
POST `/send_private_forward_msg`
```json
{"user_id": 123456789, "messages": [...]}
```

### mark_msg_as_read — Mark message as read
POST `/mark_msg_as_read`
```json
{"message_id": 123456}
```

### mark_group_msg_as_read — Mark group message as read
POST `/mark_group_msg_as_read`
```json
{"group_id": 987654321}
```

### mark_private_msg_as_read — Mark private message as read
POST `/mark_private_msg_as_read`
```json
{"user_id": 123456789}
```

### get_group_msg_history — Get group message history
POST `/get_group_msg_history`
```json
{"group_id": 987654321, "message_seq": 100, "count": 20}
```

### get_friend_msg_history — Get friend message history
POST `/get_friend_msg_history`
```json
{"user_id": 123456789, "message_seq": 100, "count": 20}
```

### get_essence_msg_list — Get essence/starred messages
POST `/get_essence_msg_list`
```json
{"group_id": 987654321}
```

### set_essence_msg — Set essence message
POST `/set_essence_msg`
```json
{"message_id": 123456}
```

### delete_essence_msg — Delete essence message
POST `/delete_essence_msg`
```json
{"message_id": 123456}
```

### send_like — Send a like/thumbs up
POST `/send_like`
```json
{"user_id": 123456789, "times": 1}
```

### set_msg_emoji_like — Set emoji reaction on message
POST `/set_msg_emoji_like`
```json
{"message_id": 123456, "emoji_id": "123"}
```

### fetch_emoji_like — Fetch emoji likes on message
POST `/fetch_emoji_like`
```json
{"message_id": 123456, "emoji_id": "123"}
```

### get_emoji_likes — Get emoji likes list
POST `/get_emoji_likes`
```json
{"message_id": 123456}
```

### set_input_status — Set input status (typing indicator)
POST `/set_input_status`
```json
{"user_id": 123456789, "group_id": 987654321, "event_type": 1}
```

### forward_friend_single_msg — Forward single message to friend
POST `/forward_friend_single_msg`
```json
{"user_id": 123456789, "message_id": 123456}
```

### forward_group_single_msg — Forward single message to group
POST `/forward_group_single_msg`
```json
{"group_id": 987654321, "message_id": 123456}
```

### fetch_ptt_text — Get PTT voice-to-text result
POST `/fetch_ptt_text`
```json
{"message_id": 123456, "group_id": 987654321}
```

---

## 2. Group APIs (群组)

### get_group_list — Get group list
POST `/get_group_list`
```json
{}
```

### get_group_info — Get group info
POST `/get_group_info`
```json
{"group_id": 987654321}
```

### get_group_info_ex — Get extended group info
POST `/get_group_info_ex`
```json
{"group_id": 987654321}
```

### get_group_detail_info — Get group detail info
POST `/get_group_detail_info`
```json
{"group_id": 987654321}
```

### get_group_member_list — Get group member list
POST `/get_group_member_list`
```json
{"group_id": 987654321}
```

### get_group_member_info — Get group member info
POST `/get_group_member_info`
```json
{"group_id": 987654321, "user_id": 123456789}
```

### get_group_honor_info — Get group honor info
POST `/get_group_honor_info`
```json
{"group_id": 987654321, "type": "all"}
```

### set_group_kick — Kick group member
POST `/set_group_kick`
```json
{"group_id": 987654321, "user_id": 123456789, "reject_add_request": false}
```

### set_group_kick_members — Kick multiple group members
POST `/set_group_kick_members`
```json
{"group_id": 987654321, "user_ids": [123, 456]}
```

### set_group_ban — Ban group member
POST `/set_group_ban`
```json
{"group_id": 987654321, "user_id": 123456789, "duration": 600}
```

### set_group_whole_ban — Mute all in group
POST `/set_group_whole_ban`
```json
{"group_id": 987654321, "enable": true}
```

### set_group_admin — Set group admin
POST `/set_group_admin`
```json
{"group_id": 987654321, "user_id": 123456789, "enable": true}
```

### set_group_card — Set group member card
POST `/set_group_card`
```json
{"group_id": 987654321, "user_id": 123456789, "card": "new name"}
```

### set_group_name — Set group name
POST `/set_group_name`
```json
{"group_id": 987654321, "group_name": "new name"}
```

### set_group_leave — Leave group
POST `/set_group_leave`
```json
{"group_id": 987654321}
```

### set_group_special_title — Set special title
POST `/set_group_special_title`
```json
{"group_id": 987654321, "user_id": 123456789, "special_title": "VIP"}
```

### set_group_portrait — Set group avatar
POST `/set_group_portrait`
```json
{"group_id": 987654321, "file": "base64://..."}
```

### set_group_add_request — Handle group join request
POST `/set_group_add_request`
```json
{"flag": "request_flag", "type": "add|invite", "approve": true, "reason": ""}
```

### get_group_system_msg — Get group system messages
POST `/get_group_system_msg`
```json
{"group_id": 987654321}
```

### get_group_at_all_remain — Get @all remaining count
POST `/get_group_at_all_remain`
```json
{"group_id": 987654321}
```

### get_group_shut_list — Get muted member list
POST `/get_group_shut_list`
```json
{"group_id": 987654321}
```

### get_group_ignored_notifies — Get ignored notifies
POST `/get_group_ignored_notifies`
```json
{"group_id": 987654321}
```

### set_group_remark — Set group remark
POST `/set_group_remark`
```json
{"group_id": 987654321, "remark": "my note"}
```

### get_group_ignore_add_request — Get ignored add requests
POST `/get_group_ignore_add_request`
```json
{}
```

### set_group_add_option — Set group add option
POST `/set_group_add_option`
```json
{"group_id": 987654321, "option": "..."}
```

### set_group_robot_add_option — Set group robot add option
POST `/set_group_robot_add_option`
```json
{"group_id": 987654321, "option": "..."}
```

### set_group_search — Set group searchable
POST `/set_group_search`
```json
{"group_id": 987654321, "enable": true}
```

### set_group_sign — Set group sign-in
POST `/set_group_sign`
```json
{"group_id": 987654321}
```

### send_group_sign — Send group sign-in
POST `/send_group_sign`
```json
{"group_id": 987654321}
```

### get_group_signed_list — Get group sign-in list
POST `/get_group_signed_list`
```json
{"group_id": 987654321}
```

### set_group_todo — Set group todo
POST `/set_group_todo`
```json
{"group_id": 987654321, "content": "..."}
```

### complete_group_todo — Complete group todo
POST `/complete_group_todo`
```json
{"group_id": 987654321, "todo_id": "..."}
```

### cancel_group_todo — Cancel group todo
POST `/cancel_group_todo`
```json
{"group_id": 987654321, "todo_id": "..."}
```

---

## 3. Friend/User APIs (好友/用户)

### get_friend_list — Get friend list
POST `/get_friend_list`
```json
{}
```

### get_friends_with_category — Get friends with category
POST `/get_friends_with_category`
```json
{}
```

### get_stranger_info — Get stranger info
POST `/get_stranger_info`
```json
{"user_id": 123456789}
```

### get_unidirectional_friend_list — Get one-way friend list
POST `/get_unidirectional_friend_list`
```json
{}
```

### set_friend_add_request — Handle friend add request
POST `/set_friend_add_request`
```json
{"flag": "request_flag", "approve": true, "remark": ""}
```

### set_friend_remark — Set friend remark
POST `/set_friend_remark`
```json
{"user_id": 123456789, "remark": "nickname"}
```

### delete_friend — Delete friend
POST `/delete_friend`
```json
{"user_id": 123456789}
```

### get_doubt_friends_add_request — Get doubtful friend requests
POST `/get_doubt_friends_add_request`
```json
{}
```

### set_doubt_friends_add_request — Handle doubtful friend request
POST `/set_doubt_friends_add_request`
```json
{"flag": "...", "approve": true}
```

### get_recent_contact — Get recent contacts
POST `/get_recent_contact`
```json
{"count": 100}
```

### send_poke / friend_poke — Send poke to friend
POST `/friend_poke`
```json
{"user_id": 123456789}
```

### group_poke — Send poke in group
POST `/group_poke`
```json
{"group_id": 987654321, "user_id": 123456789}
```

### send_poke — Universal poke
POST `/send_poke`
```json
{"user_id": 123456789, "group_id": 987654321}
```

---

## 4. File APIs (文件)

### upload_group_file — Upload group file
POST `/upload_group_file`
```json
{"group_id": 987654321, "file": "/path/to/file", "name": "file.txt", "folder": "/"}
```

### upload_private_file — Upload private file
POST `/upload_private_file`
```json
{"user_id": 123456789, "file": "/path/to/file", "name": "file.txt"}
```

### delete_group_file — Delete group file
POST `/delete_group_file`
```json
{"group_id": 987654321, "file_id": "...", "busid": 102}
```

### create_group_file_folder — Create group folder
POST `/create_group_file_folder`
```json
{"group_id": 987654321, "name": "myfolder", "folder": "/"}
```

### delete_group_folder — Delete group folder
POST `/delete_group_folder`
```json
{"group_id": 987654321, "folder": "/myfolder"}
```

### get_group_file_system_info — Get group file system info
POST `/get_group_file_system_info`
```json
{"group_id": 987654321}
```

### get_group_root_files — Get group root files
POST `/get_group_root_files`
```json
{"group_id": 987654321}
```

### get_group_files_by_folder — Get group files by folder
POST `/get_group_files_by_folder`
```json
{"group_id": 987654321, "folder": "/"}
```

### get_group_file_url — Get group file URL
POST `/get_group_file_url`
```json
{"group_id": 987654321, "file_id": "...", "busid": 102}
```

### get_private_file_url — Get private file URL
POST `/get_private_file_url`
```json
{"user_id": 123456789, "file_id": "...", "file_name": "..."}
```

### get_file — Get file info
POST `/get_file`
```json
{"file_id": "..."}
```

### download_file — Download file
POST `/download_file`
```json
{"url": "http://..."}
```

### move_group_file — Move group file/folder
POST `/move_group_file`
```json
{"group_id": 987654321, "file_id": "...", "target_folder": "/newfolder", "current_folder": "/oldfolder", "busid": 102}
```

### trans_group_file — Transfer group file to another group
POST `/trans_group_file`
```json
{"group_id": 987654321, "file_id": "...", "target_group_id": 123456, "busid": 102}
```

### rename_group_file — Rename group file
POST `/rename_group_file`
```json
{"group_id": 987654321, "file_id": "...", "new_name": "newname.txt", "busid": 102}
```

---

## 5. System APIs (系统)

### get_login_info — Get login user info
POST `/get_login_info`
```json
{}
```

### get_version_info — Get version info
POST `/get_version_info`
```json
{}
```

### get_status — Get runtime status
POST `/get_status`
```json
{}
```

### can_send_image — Check if can send image
POST `/can_send_image`
```json
{}
```

### can_send_record — Check if can send voice
POST `/can_send_record`
```json
{}
```

### get_cookies — Get cookies
POST `/get_cookies`
```json
{"domain": "qun.qq.com"}
```

### get_csrf_token — Get CSRF token
POST `/get_csrf_token`
```json
{}
```

### get_credentials — Get credentials
POST `/get_credentials`
```json
{}
```

### get_image — Get image data
POST `/get_image`
```json
{"file": "image_file_id"}
```

### get_record — Get record/voice data
POST `/get_record`
```json
{"file": "record_file_id", "out_format": "mp3"}
```

### set_restart — Restart NapCat
POST `/set_restart`
```json
{"delay": 0}
```

### clean_cache — Clean cache
POST `/clean_cache`
```json
{}
```

### bot_exit — Exit bot
POST `/bot_exit`
```json
{}
```

---

## 6. go-cqhttp Extended APIs

### set_qq_profile — Set QQ profile
POST `/set_qq_profile`
```json
{"nickname": "new name", "company": "...", "email": "...", "college": "...", "personal_note": "..."}
```

### set_qq_avatar — Set QQ avatar
POST `/set_qq_avatar`
```json
{"file": "http://... or base64://..."}
```

### set_self_longnick — Set self long nickname
POST `/set_self_longnick`
```json
{"long_nick": "my long nickname"}
```

### get_model_show — Get model show
POST `/_get_model_show`
```json
{"model": "..."}
```

### set_model_show — Set model show
POST `/_set_model_show`
```json
{"model": "...", "model_show": "..."}
```

### get_online_clients — Get online clients
POST `/get_online_clients`
```json
{}
```

### ocr_image — OCR image
POST `/ocr_image`
```json
{"image": "http://.../image.png"}
```

### send_group_notice — Send group announcement
POST `/_send_group_notice`
```json
{"group_id": 987654321, "content": "notice text"}
```

### get_group_notice — Get group announcement
POST `/_get_group_notice`
```json
{"group_id": 987654321}
```

### get_profile_like — Get profile likes
POST `/get_profile_like`
```json
{}

### handle_quick_operation — Handle quick operation
POST `/.handle_quick_operation`
```json
{"context": ..., "operation": ...}
```

### check_url_safely — Check URL safety
POST `/check_url_safely`
```json
{"url": "http://..."}
```

### translate_en2zh — Translate English to Chinese
POST `/translate_en2zh`
```json
{"words": ["hello"]}
```

### set_diy_online_status — Set custom online status
POST `/set_diy_online_status`
```json
{"diy_status_ext": "64bits_base64", "diy_status_model": 0}
```

---

## 7. NapCat Extended APIs

### set_online_status — Set online status
POST `/set_online_status`
```json
{"status": 10, "ext_status": 0}
```
status: 10=online, 30=away, 40=hidden, 50=busy, 60=Q我吧, 70=offline

### get_robot_uin_range — Get robot UIN range
POST `/get_robot_uin_range`
```json
{}
```

### nc_get_rkey — Get rkey
POST `/nc_get_rkey`
```json
{}

### nc_get_user_status — Get user online status
POST `/nc_get_user_status`
```json
{"user_id": 123456789}
```

### nc_get_packet_status — Get packet status
POST `/nc_get_packet_status`
```json
{}

### get_rkey — Get rkey (legacy)
POST `/get_rkey`
```json
{}

### get_rkey_server — Get rkey server info
POST `/get_rkey_server`
```json
{}

### get_clientkey — Get client key
POST `/get_clientkey`
```json
{}

### send_group_ark_share — Send group Ark share
POST `/send_group_ark_share`
```json
{"group_id": 987654321, "...": "..."}

### send_ark_share — Send Ark share to friend
POST `/send_ark_share`
```json
{"user_id": 123456789, "...": "..."}

### create_collection — Create collection/favorite
POST `/create_collection`
```json
{"title": "...", "content": "..."}

### get_collection_list — Get collection list
POST `/get_collection_list`
```json
{}

### fetch_custom_face — Fetch custom face
POST `/fetch_custom_face`
```json
{}

### fetch_custom_face_detail — Fetch custom face detail
POST `/fetch_custom_face_detail`
```json
{"face_id": "..."}

### add_custom_face — Add custom face
POST `/add_custom_face`
```json
{"file": "http://...", "desc": "..."}

### delete_custom_face — Delete custom face
POST `/delete_custom_face`
```json
{"face_id": "..."}

### set_custom_face_desc — Set custom face description
POST `/set_custom_face_desc`
```json
{"face_id": "...", "desc": "..."}

### send_packet — Send raw packet
POST `/send_packet`
```json
{...}

### get_mini_app_ark — Get mini app Ark JSON
POST `/get_mini_app_ark`
```json
{"app_id": "...", "...": "..."}

### get_ai_record — Get AI record
POST `/get_ai_record`
```json
{"group_id": 987654321, "chat_type": 2, "msg_id": "..."}

### send_group_ai_record — Send group AI record
POST `/send_group_ai_record`
```json
{"group_id": 987654321, "character_id": "...", "text": "..."}

### get_ai_characters — Get AI characters list
POST `/get_ai_characters`
```json
{"group_id": 987654321, "chat_type": 2}
```

### click_inline_keyboard_button — Click inline keyboard button
POST `/click_inline_keyboard_button`
```json
{"message_id": 123456, "button_id": "..."}

### get_guild_list — Get guild/server list
POST `/get_guild_list`
```json
{}

### get_guild_service_profile — Get guild profile
POST `/get_guild_service_profile`
```json
{"guild_id": "..."}

---

## 8. Album APIs (群相册)

### get_qun_album_list — Get group album list
POST `/get_qun_album_list`
```json
{"group_id": 987654321}

### get_group_album_media_list — Get album media list
POST `/get_group_album_media_list`
```json
{"group_id": 987654321, "album_id": "..."}

### upload_image_to_qun_album — Upload image to album
POST `/upload_image_to_qun_album`
```json
{"group_id": 987654321, "album_id": "...", "file": "http://..."}

### set_group_album_media_like — Like album media
POST `/set_group_album_media_like`
```json
{"group_id": 987654321, "album_id": "...", "media_id": "..."}

### cancel_group_album_media_like — Cancel album media like
POST `/cancel_group_album_media_like`
```json
{"group_id": 987654321, "album_id": "...", "media_id": "..."}

### del_group_album_media — Delete album media
POST `/del_group_album_media`
```json
{"group_id": 987654321, "album_id": "...", "media_ids": ["..."]}

### do_group_album_comment — Comment on album media
POST `/do_group_album_comment`
```json
{"group_id": 987654321, "album_id": "...", "media_id": "...", "comment": "..."}

---

## 9. Flash Transfer (闪传)

### create_flash_task — Create flash transfer task
POST `/create_flash_task`
```json
{"files": [...], "target_users": [...], "target_groups": [...]}

### send_flash_msg — Send flash message
POST `/send_flash_msg`
```json
{"group_id": 987654321, "user_id": 123456789, "fileset_id": "..."}

### get_share_link — Get share link
POST `/get_share_link`
```json
{"fileset_id": "..."}

### download_fileset — Download fileset
POST `/download_fileset`
```json
{"fileset_id": "..."}

### get_fileset_info — Get fileset info
POST `/get_fileset_info`
```json
{"fileset_id": "..."}

### get_flash_file_list — Get flash file list
POST `/get_flash_file_list`
```json
{"fileset_id": "..."}

### get_flash_file_url — Get flash file URL
POST `/get_flash_file_url`
```json
{"fileset_id": "...", "file_id": "..."}

### get_fileset_id — Get fileset ID by code
POST `/get_fileset_id`
```json
{"code": "..."}

---

## 10. Online File (在线文件)

### send_online_file — Send online file
POST `/send_online_file`
```json
{"group_id": 987654321, "user_id": 123456789, "file": "..."}

### send_online_folder — Send online folder
POST `/send_online_folder`
```json
{"group_id": 987654321, "user_id": 123456789, "folder": "..."}

### get_online_file_msg — Get online file messages
POST `/get_online_file_msg`
```json
{"group_id": 987654321, "user_id": 123456789}

### receive_online_file — Accept online file
POST `/receive_online_file`
```json
{"group_id": 987654321, "user_id": 123456789, "msg_id": "..."}

### refuse_online_file — Refuse online file
POST `/refuse_online_file`
```json
{"group_id": 987654321, "user_id": 123456789, "msg_id": "..."}

### cancel_online_file — Cancel online file
POST `/cancel_online_file`
```json
{"group_id": 987654321, "user_id": 123456789, "msg_id": "..."}

---

## 11. SSE Event Stream

NapCat HTTP server supports Server-Sent Events for real-time event push:

```
GET /_events?access_token={{NAPCAT_TOKEN}}
```

Events pushed include: message events, notice events, request events, heartbeat.

---

## Common Message CQ Codes

| CQ Code | Usage |
|---------|-------|
| `[CQ:at,qq=123456]` | @ someone |
| `[CQ:image,file=http://...]` | Send image |
| `[CQ:face,id=123]` | QQ face emoji |
| `[CQ:record,file=http://...]` | Voice message |
| `[CQ:video,file=http://...]` | Video |
| `[CQ:reply,id=123456]` | Reply to message |
| `[CQ:json,data=...]` | JSON card |
| `[CQ:xml,data=...]` | XML card |
| `[CQ:share,url=...,title=...]` | Share link |
| `[CQ:music,type=...,id=...]` | Music share |
| `[CQ:dice]` | Dice |
| `[CQ:rps]` | Rock-paper-scissors |
| `[CQ:poke,qq=123456]` | Poke someone |
| `[CQ:file,file=http://...]` | File |
