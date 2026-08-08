#!/usr/bin/env node
/**
 * schedule.test.js — CJS wrapper
 * 运行：node workers/shared/schedule.test.js
 *
 * 项目 package.json 无 type:module，CJS wrapper 通过动态 import()
 * 加载真正的 ESM 测试文件 schedule.test.mjs
 */
import('./schedule.test.mjs');
