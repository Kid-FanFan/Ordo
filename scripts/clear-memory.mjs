#!/usr/bin/env node
/**
 * 清空记忆数据库脚本
 * 用于测试：清空 BM25 数据库和向量数据库
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 数据目录
const homeDir = process.env.USERPROFILE || process.env.HOME;
const memoryDir = path.join(homeDir, '.ordo', 'memory');

console.log('🧹 清空记忆数据库');
console.log('='.repeat(50));
console.log(`数据目录: ${memoryDir}`);
console.log('');

// 检查 Ordo 是否在运行
function isOrdoRunning() {
  try {
    const output = execSync('tasklist /FI "IMAGENAME eq Ordo.exe" /NH', { encoding: 'utf-8' });
    return output.includes('Ordo.exe');
  } catch {
    return false;
  }
}

if (isOrdoRunning()) {
  console.log('⚠️  警告：检测到 Ordo 正在运行');
  console.log('⚠️  请先关闭应用，否则文件可能被锁定无法删除');
  console.log('');
  process.exit(1);
}

// 检查目录是否存在
if (!fs.existsSync(memoryDir)) {
  console.log('📂 记忆目录不存在，无需清理');
  console.log('');
  process.exit(0);
}

let totalSize = 0;
let deletedCount = 0;

console.log('📋 扫描文件和目录...\n');

// 1. 删除 SQLite 数据库文件
const dbFiles = ['memory.db', 'memory.db-shm', 'memory.db-wal'];
dbFiles.forEach(filename => {
  const filepath = path.join(memoryDir, filename);

  if (fs.existsSync(filepath)) {
    try {
      const stats = fs.statSync(filepath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      totalSize += stats.size;

      fs.unlinkSync(filepath);
      console.log(`✓ 已删除文件: ${filename} (${sizeMB} MB)`);
      deletedCount++;
    } catch (error) {
      console.log(`✗ 删除失败: ${filename} - ${error.message}`);
    }
  } else {
    console.log(`- 不存在: ${filename}`);
  }
});

// 2. 删除所有向量索引目录
console.log('\n📦 查找向量索引目录...\n');

try {
  const entries = fs.readdirSync(memoryDir, { withFileTypes: true });
  const vectorDirs = entries.filter(entry =>
    entry.isDirectory() && entry.name.startsWith('vectors_')
  );

  if (vectorDirs.length === 0) {
    console.log('- 未找到向量索引目录');
  } else {
    for (const dir of vectorDirs) {
      const dirPath = path.join(memoryDir, dir.name);

      try {
        // 计算目录大小
        let dirSize = 0;
        const files = fs.readdirSync(dirPath);
        files.forEach(file => {
          const filePath = path.join(dirPath, file);
          try {
            const stats = fs.statSync(filePath);
            dirSize += stats.size;
          } catch (err) {
            // 忽略错误
          }
        });

        const sizeMB = (dirSize / 1024 / 1024).toFixed(2);
        totalSize += dirSize;

        // 删除目录
        fs.rmSync(dirPath, { recursive: true, force: true });
        console.log(`✓ 已删除目录: ${dir.name} (${sizeMB} MB)`);
        deletedCount++;
      } catch (error) {
        console.log(`✗ 删除失败: ${dir.name} - ${error.message}`);
      }
    }
  }
} catch (error) {
  console.log(`✗ 扫描目录失败: ${error.message}`);
}

console.log('');
console.log('='.repeat(50));
console.log(`✅ 完成！共删除 ${deletedCount} 个文件/目录`);
console.log(`💾 释放空间: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
console.log('');
console.log('💡 提示：重启程序后将自动创建新的空数据库');
