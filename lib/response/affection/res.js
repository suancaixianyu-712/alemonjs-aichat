import { getAffectionLevel, resetAllAffectionLevels, resetAffectionLevel } from '../../config.js';
import { useMessage, Text } from 'alemonjs';
import { Regular } from 'alemonjs/utils';

const selects = onSelects(["message.create", "private.message.create"]);
const regular$1 = /(\/|#)(查看)?好感度?$/i;
const regular$2 = /(\/|#)(重置|清空)(全部|所有)?好感度?$/i;
const regular = Regular.or(regular$1, regular$2);
var res = onResponse(selects, async (e, next) => {
    // 创建
    const [message] = useMessage(e);
    // 查看好感度
    if (regular$1.test(e.msg)) {
        const affections = await getAffectionLevel(e.uidkey);
        message.send(format(Text(`当前用户\`${e.UserName}\`的好感度为: ${affections}。`)));
        return;
    }
    // 重置好感度
    if (regular$2.test(e.msg)) {
        if ((e.msg.includes("全部") && e.IsMaster) ||
            (e.msg.includes("所有") && e.IsMaster)) {
            await resetAllAffectionLevels();
            message.send(format(Text(`已重置所有用户的好感度。`)));
        }
        else {
            await resetAffectionLevel(e.uidkey);
            message.send(format(Text(`已重置用户\`${e.UserName}\`的好感度。`)));
        }
    }
    next();
});

export { res as default, regular, selects };
