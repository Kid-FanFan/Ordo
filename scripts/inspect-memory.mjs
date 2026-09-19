// 记忆系统数据查看工具
// 用法：node scripts/inspect-memory.mjs

import Database from 'better-sqlite3';
import { LocalIndex } from 'vectra';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 默认数据目录（根据实际情况修改）
const DATA_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.ordo', 'memory');

console.log('='.repeat(80));
console.log('记忆系统数据查看工具');
console.log('='.repeat(80));
console.log(`数据目录: ${DATA_DIR}\n`);

// ========================================
// 1. SQLite 数据库检查
// ========================================
const dbPath = path.join(DATA_DIR, 'memory.db');

if (!fs.existsSync(dbPath)) {
  console.log('❌ 数据库文件不存在');
  process.exit(0);
}

const db = new Database(dbPath, { readonly: true });

console.log('📊 SQLite 数据库信息');
console.log('-'.repeat(80));

// 对话记录统计
const conversationCount = db.prepare('SELECT COUNT(*) as count FROM conversations').get();
console.log(`✅ 对话记录总数: ${conversationCount.count}`);

// 按会话统计
const sessionStats = db.prepare(`
  SELECT session_id, COUNT(*) as count, MIN(timestamp) as first, MAX(timestamp) as last
  FROM conversations
  GROUP BY session_id
  ORDER BY last DESC
  LIMIT 10
`).all();

console.log(`\n📋 最近 10 个会话:`);
sessionStats.forEach((s, i) => {
  const firstDate = new Date(s.first).toLocaleString('zh-CN');
  const lastDate = new Date(s.last).toLocaleString('zh-CN');
  console.log(`  ${i + 1}. 会话 ${s.session_id.slice(0, 8)}... - ${s.count} 条对话`);
  console.log(`     首次: ${firstDate}, 最后: ${lastDate}`);
});

// BM25 索引统计
try {
  // FTS5 的 content 表不能直接 COUNT，需要通过原表统计
  const ftsCount = db.prepare('SELECT COUNT(*) as count FROM conversations').get();
  console.log(`\n✅ BM25 索引记录数: ${ftsCount.count}`);

  // 测试 BM25 搜索功能
  try {
    const testResult = db.prepare(`
      SELECT COUNT(*) as count
      FROM conversations_fts
      WHERE conversations_fts MATCH '你好'
    `).get();
    console.log(`✅ BM25 搜索测试 ("你好"): ${testResult.count} 条结果`);
  } catch (e) {
    console.log(`⚠️  BM25 搜索测试失败: ${e.message}`);
  }
} catch (error) {
  console.log(`\n❌ BM25 索引异常: ${error.message}`);
}

// 向量索引元数据
try {
  const vectorMetaCount = db.prepare('SELECT COUNT(*) as count FROM vector_index_meta').get();
  console.log(`✅ 向量索引元数据记录数: ${vectorMetaCount.count}`);
} catch (error) {
  console.log(`❌ 向量索引元数据异常: ${error.message}`);
}

// 向量服务状态
try {
  const vectorStatus = db.prepare('SELECT * FROM vector_service_status WHERE id = 1').get();
  console.log(`\n🔧 向量服务状态:`);
  console.log(`  启用状态: ${vectorStatus.is_enabled ? '✅ 已启用' : '❌ 未启用'}`);
  if (vectorStatus.is_enabled) {
    console.log(`  端点: ${vectorStatus.endpoint_url || '未配置'}`);
    console.log(`  模型: ${vectorStatus.model_name || '未配置'}`);
    console.log(`  状态: ${vectorStatus.status}`);
    console.log(`  连续失败次数: ${vectorStatus.consecutive_failures}`);
    if (vectorStatus.last_success_at) {
      console.log(`  最后成功: ${new Date(vectorStatus.last_success_at).toLocaleString('zh-CN')}`);
    }
    if (vectorStatus.last_failure_at) {
      console.log(`  最后失败: ${new Date(vectorStatus.last_failure_at).toLocaleString('zh-CN')}`);
    }
  }
} catch (error) {
  console.log(`\n❌ 向量服务状态查询失败: ${error.message}`);
}

// 显示最近几条对话样本
console.log(`\n💬 最近 3 条对话样本:`);
const recentConversations = db.prepare(`
  SELECT id, session_id, user_input, assistant_output, summary, timestamp
  FROM conversations
  ORDER BY timestamp DESC
  LIMIT 3
`).all();

recentConversations.forEach((conv, i) => {
  console.log(`\n  --- 对话 ${i + 1} (ID: ${conv.id}) ---`);
  console.log(`  时间: ${new Date(conv.timestamp).toLocaleString('zh-CN')}`);
  console.log(`  用户: ${conv.user_input.slice(0, 60)}${conv.user_input.length > 60 ? '...' : ''}`);
  console.log(`  助手: ${conv.assistant_output.slice(0, 60)}${conv.assistant_output.length > 60 ? '...' : ''}`);
  if (conv.summary) {
    console.log(`  总结: ${conv.summary}`);
  }
});

db.close();

// ========================================
// 2. Vectra 向量索引检查
// ========================================
console.log('\n' + '='.repeat(80));
console.log('🔍 Vectra 向量索引信息');
console.log('-'.repeat(80));

// 查找所有 vectors_* 目录
const vectorDirs = fs.readdirSync(DATA_DIR).filter(name => name.startsWith('vectors_'));

if (vectorDirs.length === 0) {
  console.log('❌ 未找到向量索引目录');
} else {
  console.log(`✅ 找到 ${vectorDirs.length} 个向量索引目录:\n`);

  for (const dirName of vectorDirs) {
    const vectorIndexPath = path.join(DATA_DIR, dirName);
    console.log(`📁 ${dirName}`);

    try {
      const index = new LocalIndex(vectorIndexPath);
      const isCreated = await index.isIndexCreated();

      if (!isCreated) {
        console.log('   ❌ 索引未创建');
      } else {
        console.log('   ✅ 索引已创建');

        // 读取索引文件大小
        const indexJsonPath = path.join(vectorIndexPath, 'index.json');
        if (fs.existsSync(indexJsonPath)) {
          const stats = fs.statSync(indexJsonPath);
          const sizeKB = (stats.size / 1024).toFixed(2);
          console.log(`   📦 索引文件: ${sizeKB} KB`);

          // 尝试读取索引内容统计
          try {
            const indexData = JSON.parse(fs.readFileSync(indexJsonPath, 'utf-8'));
            if (indexData.items) {
              console.log(`   📊 向量记录数: ${Object.keys(indexData.items).length}`);

              // 显示一条向量记录信息
              const firstKey = Object.keys(indexData.items)[0];
              if (firstKey) {
                const item = indexData.items[firstKey];
                console.log(`   🔢 向量维度: ${item.vector ? item.vector.length : '未知'}`);
              }
            }
          } catch (e) {
            console.log(`   ⚠️  无法读取索引详情: ${e.message}`);
          }
        }
      }
    } catch (error) {
      console.log(`   ❌ 索引检查失败: ${error.message}`);
    }
    console.log('');
  }
}

// ========================================
// 3. 配置文件检查
// ========================================
const configPath = path.join(DATA_DIR, 'memory-config.json');

console.log('\n' + '='.repeat(80));
console.log('⚙️  配置文件信息');
console.log('-'.repeat(80));

if (!fs.existsSync(configPath)) {
  console.log('❌ 配置文件不存在（使用默认配置）');
} else {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    console.log('✅ 配置文件存在\n');
    console.log(JSON.stringify(config, null, 2));
  } catch (error) {
    console.log(`❌ 配置文件读取失败: ${error.message}`);
  }
}

console.log('\n' + '='.repeat(80));
console.log('检查完成');
console.log('='.repeat(80));
