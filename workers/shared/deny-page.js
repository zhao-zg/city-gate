/**
 * 共享 403 页面模板
 * @param {string} city
 * @param {string} region
 * @param {string} country
 * @returns {string} HTML
 */
export function denyPage(city, region, country) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>访问受限</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      color: #fff;
    }
    .card {
      background: rgba(255,255,255,0.12);
      backdrop-filter: blur(20px);
      border-radius: 20px;
      padding: 48px 40px;
      max-width: 420px;
      text-align: center;
      border: 1px solid rgba(255,255,255,0.2);
    }
    .icon { font-size: 64px; margin-bottom: 24px; }
    h1 { font-size: 24px; margin-bottom: 12px; }
    p { font-size: 14px; line-height: 1.8; opacity: 0.9; }
    .info {
      margin-top: 20px;
      padding: 12px 20px;
      background: rgba(255,255,255,0.1);
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#128274;</div>
    <h1>访问受限</h1>
    <p>您所在的地区暂不支持访问<br>如有需要请联系管理员</p>
    <div class="info">
      您的 IP 归属地：${city || '未知'}${region ? '，' + region : ''}${country ? '，' + country : ''}
    </div>
  </div>
</body>
</html>`;
}
