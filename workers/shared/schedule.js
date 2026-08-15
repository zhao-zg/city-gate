/**
 * ⚠ DEPRECATED — 本文件已废弃（2026-08-15）
 * 原因：Worker 重构为透明传输模式，不再使用时段控制。
 * 保留仅供历史参考。
 *
 * schedule.js — Cloudflare Workers ESM 入口
 *
 * Workers 使用此文件导入；实际逻辑在 schedule.mjs（Node.js ESM 可直接加载）。
 * 运行测试：node workers/shared/schedule.test.js
 */
export { parseTime, isInOpenSchedule } from './schedule.mjs';
