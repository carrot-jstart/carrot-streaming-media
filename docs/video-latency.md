# 视频延迟测量与平台对接

日期：2026-11-11。替换此前网页状态栏中始终接近 `0ms` 的错误计算。

本轮修改在本地 `src/tools/vehicle_media` 和 `E:/carrot-streaming-media` 原文件中。
**2026-11-11 已将车端源码和二进制同步到 Jetson，并逐路恢复四路推流；线上平台尚未升级。
真实平台 WebSocket 抽测 stream0 的 564 帧均保留车端时间戳，但完整网页延迟显示仍未验收。**
现场线上 `/js/carrot-sdk.js` 为 1.0.0，`/api/time` 返回 404；平台部门需部署本地修改后的
Go 服务、SDK 1.1.0 和网页文件，清理旧缓存。车端该次时钟误差估计为 431–441 ms，
显示误差应照实保留，不能把该精度作为毫秒级精确测量。

## 显示含义

新版 CarrotSDK 1.1.0 显示两项独立指标：

- **取帧→绘制估算**：车端原始帧离开采集源，到浏览器调用 Canvas `drawImage` 提交绘制的时间。
  包括转换、编码、排队、车端上行、平台转发、下行和浏览器解码处理。显示估算值及误差估计。
- **网页处理**：该帧进入浏览器 WebSocket 消息回调，到调用 Canvas 绘制的本地单调时钟耗时。
  不包括该帧到达回调前的传输时间，不能代替车端到网页的延迟。

示例：`取帧→绘制估算:240ms ±35ms | 网页处理:8.6ms`。
示例仅说明格式，不是实测结果。

测量起点是应用取到原始帧的时刻，不含传感器曝光、ISP 和此前驱动缓冲时间；终点不是显示器
真正发光的时刻。因此它不是完整的 glass-to-glass 延迟，也不是控制指令往返时延。
误差值来自时钟状态、网络采样及保守的时钟老化估计，并非严格的物理误差保证。

无法测量时显示 `--` 及原因，例如车端无时间戳、车端／平台时钟未同步、对时接口不可用、
对时已过期或时钟偏差异常。旧码流继续播放，不再用 0 充当未知延迟。

## 车端实现

`video_timestamps=true`，默认开启。配置页新增四路对应开关，保存后重启该路生效。

1. 采集源 src pad 记录 UTC 毫秒和 Linux 时钟同步状态，以帧的 running-time 为关联键。
2. 编码后的 AVC/AU 数据按其 segment 转换到同一 running-time，关联原始帧。
   不直接假定编码器输入和输出的绝对 PTS 相同，允许编码器引入 segment 偏移。
3. 向该帧插入 H.264 `user_data_unregistered` SEI；存在 AUD 时保持 AUD 在前。
   原编码图像数据共享内存，不改相机格式、分辨率、码率、GOP、B 帧或原始表面。
4. 关联历史最多 256 帧；无效、过期或重复的关联键不猜测匹配，缺失时间戳由网页显示不可测。

SEI 使用 UUID `b7e54ad8-9a31-4df7-b8dd-87ac6e29cc71`。H.264 payload type 为 5，
payload 长 30 字节：UUID 16 字节、版本 1 字节（1）、标志 1 字节（bit0 时钟已同步）、
UTC 毫秒 8 字节、时钟最大误差毫秒 4 字节。多字节数为大端，按 H.264 规则插入防竞争字节。
外层仍为四字节 NAL 长度的 AVCC，保留现有 FLV/RTMP/WSS 帧协议。

Linux `adjtimex` 的 modes 为 0，只查询状态，不修改时钟。车端每秒缓存查询一次；
未同步、查询失败或误差超过 1 秒时，不将其声明为已校时。该状态随每帧 SEI 传递。

## 平台服务端

媒体 NAL 原样转发，不需要改 RTMP 接入地址或 WSS 视频消息头。新增同域接口：

```text
GET https://<媒体服务器>:7777/api/time
```

响应例子（时间和误差均为示例）：

```json
{"unix_ms":1794370000000,"synchronized":true,"max_error_ms":7}
```

返回 `Cache-Control: no-store`，只接受 GET；允许跨域读取这个公开时间接口。
如有反向代理，应将 `/api/time` 转发至同一 Go 服务并禁用缓存。
Linux 服务通过只读 `adjtimex` 查询时钟；其他操作系统暂不声明时钟已同步。

浏览器连续采样三次，选择最短 RTT 的有效结果，将平台 UTC 锚定到 `performance.now()`。
每 60 秒重采样，超过 90 秒的样本不用于延迟估算。驾驶舱电脑本地墙钟无需直接参与计算，
车端和平台仍需可靠对时。SDK 不会自动修改任何设备时钟。

估算误差包含车端误差、平台误差、RTT/2、样本老化和量化余量。任一端未校时、接口失败、
异常／过期样本或负帧龄均不生成伪造的端到端数值。

## 网页和 SDK 对接

实际入口仍为：

```text
https://djhaf.dyngentech.cn:7777/?videoUrl=live/stream0
```

更新 `web/js/carrot-sdk.js` 和 `web/index.html`；页面引用已加 `?v=1.1.0`，避免继续使用缓存旧文件。
平台嵌入自有页面时也应更新其 SDK 资源版本，读取 `CarrotSDK.version` 确认为 `1.1.0`。
旧 `web/js/player.js` 只显示不支持测量的提示，完整测量请使用统一 SDK。

`onStats` 新字段：

```javascript
const player = new CarrotSDK.Player({
  videoUrl: 'live/stream0',
  onStats: stats => {
    const text = stats.endToEndLatencyMs === null
      ? `不可测：${stats.latencyUnavailableReason}`
      : `约 ${stats.endToEndLatencyMs.toFixed(0)} ms`;
    console.log(text, stats.latencyUncertaintyMs, stats.receiveToRenderMs);
  }
});
player.connect();
```

这个示例与原有手动创建 Player 的方式一致。
`endToEndLatencyMs`、`latencyUncertaintyMs`、`receiveToRenderMs` 为 number 或 null。
`latencyUnavailableReason` 为不可测原因；旧字段 `latency` 现在是 `endToEndLatencyMs` 的别名，
也可能为 null。平台代码不要用 `stats.latency || 0` 掩盖不可测状态。

## 更新顺序与验收

1. 本地最终 C++ 回归已完成，在停推窗口更新并重编译 `vehicle_media`。
   车端当时已重新启动遥操媒体节点，本轮没有停止或替换这些运行实例。
2. 平台部门重新编译 Go 服务，并更新 SDK 和入口 HTML。单独更新 SDK 只能得到网页处理耗时；
   旧车端没有时间戳或平台缺少对时接口时，取帧→绘制应显示不可测。
3. 验证车端 `timedatectl show -p NTPSynchronized`、必要时 `chronyc tracking`，
   并确认平台 `/api/time` 返回已同步。对时由运维按现有流程管理。
4. 查看新视频状态栏和 `onStats`。确认时间戳对应同一输出帧，停止／重推后旧数据不串到新会话；
   旧流、失去对时、接口不可达时显示不可测。
5. 实车复测四路 FPS、CPU、画质与重连，测量附加开销尚未在 Orin 四路实测；
   需要物理端到端验收时，仍应使用可见计时器或同步闪光进行独立对照。

## 验证进度

- Node：新增 16 项延迟测试和原有 12 项重连测试，共 28 项通过。
  覆盖旧码流、未对时、接口失败、时钟异常、过期、乱序输出、旧回调、缓存上限和异常元数据。
- Go：`go test -mod=readonly ./...` 通过；已验证 SEI 转发保持原样。
  Linux amd64/arm64 测试程序交叉编译成功，Linux amd64 的对时和 WebSocket 测试通过。
- C++：最终完整编译和四组 CTest 通过（17.92 秒）。验证 SEI、乱序／有界帧关联、
  AUD 顺序保护，以及真实合成编码、running-time 归一化、FLV 封装／解封装后五帧时间戳全部保留。
  集成测试使用本机 x264enc 直接输出 AVC/AU，不依赖该开发机缺少的可选 h264parse 插件。
- 配置页面：138 项参数的 10 项隔离测试通过（8.356 秒）。
- 现网真实延迟、RTMP 实际完整链路和新增开销尚未验收。

本机回归命令（在 Ubuntu-20.04-ctp 内执行）：

```bash
cd /mnt/e/code/auto_djyx_scooptram
source /opt/ros/noetic/setup.bash
cmake --build build/vehicle_media_latency_validation -j2
cd build/vehicle_media_latency_validation
ctest --output-on-failure
```

协议参考：
[GStreamer 探针](https://gstreamer.freedesktop.org/documentation/additional/design/probes.html)、
[Linux adjtimex](https://man7.org/linux/man-pages/man2/adjtimex.2.html)、
[FFmpeg H.264 SEI 解析实现](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264_sei.c)。
