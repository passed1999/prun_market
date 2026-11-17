# PrUn Price Guard

独立的浏览器扩展（Chrome / Edge / Firefox，Manifest V3）：在游戏里下买单时，限价比参考价高出设定的阈值就**拦下这次点击并提醒**。

参考价就是 Refined PrUn 在 `MAT` 窗口里显示的 **Refined PrUn Price**（数据同源、算法相同）。
本扩展自己取数，不依赖 rprun；两者同时装也可以。

## 安装

扩展就是 `extension/price-guard/` 这个文件夹，不需要构建。

- **Chrome / Edge**：打开 `chrome://extensions`（Edge 是 `edge://extensions`）→ 打开「开发者模式」→「加载已解压的扩展程序」→ 选 `price-guard` 文件夹。
- **Firefox**（127 及以上）：打开 `about:debugging#/runtime/this-firefox` →「临时载入附加组件」→ 选 `price-guard/manifest.json`。
  临时载入的扩展在 Firefox 重启后会消失；要长期装，需要把文件夹打成 zip 到 [AMO](https://addons.mozilla.org/developers/) 做一次（不公开的）签名。

装好后刷新游戏页面。

## 怎么判断

只在 `CXPO`（下单）窗口点 **BUY** 时判断，卖单不管。拿「限价」和参考价比 —— 成交价不会高于限价，所以限价没超就一定没超。

三种阈值，各自可开可关，**任何一项启用的被超过就拦截**：

| 阈值 | 含义 | 例 |
|---|---|---|
| 相对值 | 限价比参考价高出的百分比 | 20 → 高出超过 20% 就拦 |
| 单价绝对值 | 每件比参考价贵出的金额 | 20 → 每件贵出超过 20 就拦 |
| 总价绝对值 | 整单比按参考价买多付的金额（贵出的单价 × 数量） | 10000 → 整单多付超过 10000 就拦 |

默认只开相对值 20%。

以下情况也会拦（因为没法判断）：没填限价、参考价还没读到、这种材料没有参考价。

被拦之后有两处可以放行，都只对被拦下的那一笔（材料、限价、数量都不变）有效一次：

- 页面顶部弹出的提醒上有「取消本次拦截」：点了就照原样把这一笔下出去，不用再点 BUY。提醒 20 秒后自动消失。
- CXPO 窗口底部的提示条会变红并说明原因，旁边有「本次放行」：点了之后 15 秒内再点一次 BUY 才会下单。

rprun 的 `XIT ACT` 自动下单同样是点 BUY，所以也会被拦；被拦时 ACT 那一步会卡住等待。

## 设置：`XIT SET-PRICE-GUARD`

设置只有这一条指令。在游戏里新开一个窗口输入 `XIT SET-PRICE-GUARD`，打开设置面板，在面板里改。

也可以把要改的内容直接写在指令后面，一条指令里能写任意多组「项目 值」：

| 写法 | 作用 |
|---|---|
| `XIT SET-PRICE-GUARD` | 只打开设置面板 |
| `XIT SET-PRICE-GUARD REL 20 UNIT 20 TOTAL 10000` | 相对值 20%、单价绝对值 20、总价绝对值 10000；写哪项改哪项 |
| `XIT SET-PRICE-GUARD REL OFF` | 数值换成 `OFF` 就是关掉那一项 |
| `XIT SET-PRICE-GUARD REF UNIVERSE VWAP7D` | 参考价的交易所与算法 |
| `XIT SET-PRICE-GUARD OFF` / `ON` | 总开关 |

有一处写错，整条指令都不执行，面板里会说明错在哪。带参数的指令只在窗口第一次打开时执行一次，
窗口留在屏幕上、刷新页面后不会重复执行。

参考价默认是 `UNIVERSE · DEFAULT`，和 rprun 的默认一致。如果你在 rprun 的 `XIT SET` 里改过 pricing，
这里要选成一样的，数字才会和 `MAT` 窗口里的对上。`LOCAL` 表示用下单所在的那个交易所的价。

## 打包分发

```bash
python scripts/pack_extension.py
```

在 `extension/dist/` 生成两个包（版本号取自 `manifest.json`）：

- `prun-price-guard-<版本>.zip`：发给别人用。解压后是 `price-guard` 文件夹和一份 `安装说明.txt`。
- `prun-price-guard-<版本>-store.zip`：manifest 在压缩包根目录，上传 Chrome 应用商店 / Edge 加载项 / Firefox AMO 签名用。

## 开发

```bash
node --test extension/test/core.test.js
```

`extension/test/mock.html` 是不登录游戏也能试的模拟页面（`npm run dev` 后打开
`http://localhost:5173/extension/test/mock.html`）：照游戏的 class 名搭了 CXPO 与 XIT 窗口，扩展 API 用 localStorage 顶替。

界面的 class 名（`TileFrame__cmd`、`ComExPlaceOrderForm__form`、`Button__success`、`ScrollView__view`）取自 rprun 源码 2026-11 的版本。
