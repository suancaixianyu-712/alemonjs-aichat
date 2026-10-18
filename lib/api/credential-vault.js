import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, createHash, createDecipheriv, createCipheriv } from 'node:crypto';

/** 凭据不是普通记忆或配置：按主人隔离，加密保存在 public/ 和源码之外。 */
class CredentialVault {
    directory;
    constructor(directory = path.join(homedir(), ".alemonjs-aichat", "credentials")) {
        this.directory = directory;
    }
    key() {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        if (fs.lstatSync(this.directory).isSymbolicLink())
            throw new Error("凭据目录不能是符号链接");
        fs.chmodSync(this.directory, 0o700);
        const file = path.join(this.directory, "master.key");
        if (!fs.existsSync(file)) {
            if (fs.readdirSync(this.directory).some((name) => name.endsWith(".json.enc")))
                throw new Error("凭据密钥缺失，请恢复原密钥，不能自动重新生成");
            try {
                fs.writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 });
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
            }
        }
        if (fs.lstatSync(file).isSymbolicLink())
            throw new Error("凭据密钥不能是符号链接");
        fs.chmodSync(file, 0o600);
        const key = fs.readFileSync(file);
        if (key.length !== 32)
            throw new Error("凭据密钥无效，请恢复原密钥，不能自动覆盖");
        return key;
    }
    file(owner) {
        if (typeof owner !== "string" || !owner.trim())
            throw new Error("凭据管理和使用仅主人私聊可用");
        return path.join(this.directory, `${createHash("sha256").update(owner).digest("hex")}.json.enc`);
    }
    read(owner) {
        const file = this.file(owner);
        const key = this.key();
        if (!fs.existsSync(file))
            return Object.create(null);
        try {
            if (fs.lstatSync(file).isSymbolicLink())
                throw new Error();
            const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
            if (envelope.version !== 1)
                throw new Error();
            const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
            decipher.setAAD(Buffer.from(owner));
            decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
            return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
        }
        catch {
            throw new Error("凭据文件无法解密或已损坏，请检查原始文件与密钥");
        }
    }
    write(owner, records) {
        const file = this.file(owner);
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
        cipher.setAAD(Buffer.from(owner));
        const data = Buffer.concat([cipher.update(JSON.stringify(records), "utf8"), cipher.final()]);
        const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
        try {
            fs.writeFileSync(temp, JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { flag: "wx", mode: 0o600 });
            fs.renameSync(temp, file);
        }
        finally {
            if (fs.existsSync(temp))
                fs.unlinkSync(temp);
        }
    }
    list(owner) {
        return Object.entries(this.read(owner)).map(([name, record]) => ({ name, fields: Object.keys(record.fields), updatedAt: record.updatedAt }));
    }
    save(owner, name, fields) {
        if (typeof name !== "string" || !/^[\p{L}\p{N}_.-]{1,80}$/u.test(name) || ["__proto__", "constructor", "prototype"].includes(name))
            throw new Error("凭据名称须为 1–80 位中文、字母、数字、点、下划线或短横线");
        if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length || Object.keys(fields).length > 50)
            throw new Error("fields 必须包含 1–50 个凭据字段");
        for (const [key, value] of Object.entries(fields)) {
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || typeof value !== "string" || !value.length || value.length > 65536 || value.includes("\0"))
                throw new Error("凭据字段须为合法字段名和非空字符串，且不能包含空字符");
        }
        const records = this.read(owner);
        records[name] = { fields: { ...fields }, updatedAt: new Date().toISOString() };
        this.write(owner, records);
        return { name, fields: Object.keys(fields), updatedAt: records[name].updatedAt };
    }
    delete(owner, name) {
        const records = this.read(owner);
        const existed = Object.hasOwn(records, name);
        delete records[name];
        if (existed)
            this.write(owner, records);
        return { name, deleted: existed };
    }
    resolveEnv(owner, mapping) {
        if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || Object.keys(mapping).length > 50)
            throw new Error("credentialEnv 必须为不超过 50 项的环境变量映射");
        const records = this.read(owner);
        const env = {};
        for (const [variable, ref] of Object.entries(mapping)) {
            if (!/^[A-Z_][A-Z0-9_]*$/.test(variable) || !ref || typeof ref.name !== "string" || typeof ref.field !== "string")
                throw new Error("credentialEnv 格式错误，应为环境变量名到 {name, field} 的映射");
            const record = Object.hasOwn(records, ref.name) ? records[ref.name] : undefined;
            if (!record || !Object.hasOwn(record.fields, ref.field))
                throw new Error("指定凭据或字段不存在，请先列出凭据确认名称");
            env[variable] = record.fields[ref.field];
        }
        return { env, secrets: Object.values(records).flatMap((record) => Object.values(record.fields)) };
    }
}
const credentialVault = new CredentialVault();
const redactCredentialValues = (text, secrets) => {
    let output = text;
    for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) {
        for (const variant of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
            if (variant)
                output = output.split(variant).join("[凭据已隐藏]");
        }
    }
    return output;
};

export { CredentialVault, credentialVault, redactCredentialValues };
