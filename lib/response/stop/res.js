import { Text } from 'alemonjs';
import { useMessage } from '../../utils/command-message.js';
import { abortAITurns } from '../../api/ai-turn.js';
import { abortOpencodeRuns } from '../../api/opencode.js';
import redisClient from '../../config.js';

const selects = onSelects(["message.create", "private.message.create"]);
var res = onResponse(selects, async (e) => {
    const [message] = useMessage(e);
    const userID = String(e.UserId || "");
    const { aborted: aiTurnsAborted } = abortAITurns({
        guid: e.guid,
        platform: e.Platform,
        userID,
    });
    const { aborted: opencodeRunsAborted } = await abortOpencodeRuns({
        guid: e.guid,
        userID,
    });
    if (aiTurnsAborted > 0 || opencodeRunsAborted > 0) {
        await Promise.all([
            redisClient.releaseAIToolLoop(e.guid, userID, e.Platform),
            redisClient.drainAIGuidanceMessages(e.guid, e.Platform),
        ]);
    }
    if (aiTurnsAborted > 0) {
        await message.send(format(Text("已停止当前这轮 AI 回复")));
    }
    else if (opencodeRunsAborted > 0) {
        await message.send(format(Text(`已终止 ${opencodeRunsAborted} 个正在运行的任务`)));
    }
    else {
        await message.send(format(Text("当前没有正在运行的任务")));
    }
});

export { res as default, selects };
