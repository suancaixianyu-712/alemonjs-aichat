import { crc32, deflateRawSync } from "node:zlib";

export const makeZip = (name, source, { method = 8, attrs = 0, size = source.length, flags = 0 } = {}) => {
  const filename = Buffer.from(name);
  const data = method === 0 ? source : deflateRawSync(source);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8);
  header.writeUInt32LE(crc32(source), 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(size, 22);
  header.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc32(source), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(size, 24);
  central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(attrs >>> 0, 38);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(header.length + filename.length + data.length, 16);
  return Buffer.concat([header, filename, data, central, filename, end]);
};
export const makeTar = (items) => {
  const result = [];
  for (const { name, data = Buffer.alloc(0), type = "0" } of items) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write("0000644\0", 100);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.fill(32, 148, 156); header.write(type, 156); header.write("ustar\0", 257);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    result.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...result, Buffer.alloc(1024)]);
};

