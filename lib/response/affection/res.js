import redisClient from '../../config.js';
import { Text } from 'alemonjs';
import { useMessage } from '../../utils/command-message.js';

const selects = onSelects(["message.create", "private.message.create"]);
var res = onResponse(selects, async (e, next) => {
    // 创建
    const [message] = useMessage(e);
    // 查看好感度
    if (/(\/|#)(查看)?好感度?$/i.test(e.msg)) {
        const affections = await redisClient.getAffectionLevel(e.guid, e.UserName);
        message.send(format(Text(`当前用户\`${e.UserName}\`的好感度为: ${affections}。`)));
        return;
    }
    // 重置好感度
    if (/(\/|#)(重置|清空)(全部|所有)?好感度?$/i.test(e.msg)) {
        if ((e.msg.includes("全部") && e.IsMaster) ||
            (e.msg.includes("所有") && e.IsMaster)) {
            await redisClient.resetAllAffectionLevels();
            message.send(format(Text(`已重置所有用户的好感度。`)));
        }
        else {
            await redisClient.resetAffectionLevel(e.guid, e.UserName);
            message.send(format(Text(`已重置用户\`${e.UserName}\`的好感度。`)));
        }
    }
    next();
});

export { res as default, selects };
