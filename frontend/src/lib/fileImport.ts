const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
export const MAX_REFERENCE_CHARS = 300000;

export function readPromptImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) return Promise.reject(new Error("请选择图片文件。"));
  if (file.size > MAX_IMAGE_BYTES) return Promise.reject(new Error(`图片「${file.name}」超过 10MB，请压缩后重试。`));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result) : reject(new Error("图片读取失败，请重新选择。"));
    reader.onerror = () => reject(new Error("图片读取失败，请重新选择。"));
    reader.onabort = () => reject(new Error("图片读取已取消。"));
    reader.readAsDataURL(file);
  });
}

export async function readReferenceFiles(files: File[], label: string): Promise<string> {
  let result = "";
  for (const file of files.slice(0, 40)) {
    if (file.size > MAX_REFERENCE_BYTES) throw new Error(`资料「${file.name}」超过 5MB，请分拆后导入。`);
    const text = (await file.text()).replace(/\r\n?/g, "\n").trim();
    const block = `#### ${label}：\`${file.name}\`\n\n${text}`;
    result = `${result}${result ? "\n\n" : ""}${block}`.slice(0, MAX_REFERENCE_CHARS);
    if (result.length === MAX_REFERENCE_CHARS) break;
  }
  return result;
}

export function appendReferences(current: string, imported: string): string {
  return `${current}${current ? "\n\n" : ""}${imported}`.slice(0, MAX_REFERENCE_CHARS);
}
