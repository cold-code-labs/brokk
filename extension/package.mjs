import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";

const dir = new URL("./", import.meta.url);
const output = new URL("../public/downloads/", import.meta.url);
await mkdir(output, { recursive: true });
await mkdir(new URL("../public/extension/", import.meta.url), {
  recursive: true,
});
const local = [],
  central = [];
let offset = 0;
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
const assets = (await readdir(dir)).filter((name) =>
  /\.(json|js|html|css)$/.test(name),
);
for (const name of await readdir(new URL("icons/", dir))) {
  if (/^icon-(16|32|48|128)\.png$/.test(name)) assets.push(`icons/${name}`);
}
for (const name of assets.sort()) {
  const data = await readFile(new URL(name, dir)),
    file = Buffer.from(name),
    crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt16LE(20, 4);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(file.length, 26);
  const index = Buffer.alloc(46);
  index.writeUInt32LE(0x02014b50);
  index.writeUInt16LE(20, 4);
  index.writeUInt16LE(20, 6);
  index.writeUInt32LE(crc, 16);
  index.writeUInt32LE(data.length, 20);
  index.writeUInt32LE(data.length, 24);
  index.writeUInt16LE(file.length, 28);
  index.writeUInt32LE(offset, 42);
  local.push(header, file, data);
  central.push(index, file);
  offset += header.length + file.length + data.length;
  if (["privacy.html", "support.html"].includes(name))
    await copyFile(
      new URL(name, dir),
      new URL(`../public/extension/${name}`, import.meta.url),
    );
}
const directory = Buffer.concat(central),
  end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(central.length / 2, 8);
end.writeUInt16LE(central.length / 2, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
await writeFile(
  new URL("brokk-review.zip", output),
  Buffer.concat([...local, directory, end]),
);
