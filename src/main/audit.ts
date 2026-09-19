// 审计：JSONL 追加写（对应 PRD 5.3 敏感操作明细的客户端侧数据源）
// 降级场景下同样本地落盘、恢复后补传（对应 PRD 4.6）
import * as fs from "node:fs";
import * as path from "node:path";

export class Audit {
  constructor(private dir: string) {}

  append(record: Record<string, unknown>): void {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(this.dir, `audit-${day}.jsonl`);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
    fs.appendFileSync(file, line, "utf-8");
  }
}
