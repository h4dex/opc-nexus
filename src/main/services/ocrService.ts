/**
 * PaddleOCR WASM 本地 OCR 服务
 * 基于 onnxruntime-node（WASM 后端）+ PP-OCRv4 ONNX 模型，实现离线中英文文字识别。
 * - 模型首次使用时自动下载到 userData/aibox-data/ocr-models/
 * - 可通过设置 ocr_enabled 开关启用/禁用
 * - 支持 PNG/JPG/BMP/WEBP 格式图片
 */
import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Database } from './database.js';

// ---------- 类型 ----------

export interface OcrBox {
  /** 四点坐标 [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] */
  box: [number, number][];
  text: string;
  confidence: number;
}

export interface OcrResult {
  ok: boolean;
  text: string;
  boxes: OcrBox[];
  elapsed: number;
  error?: string;
}

export interface OcrStatus {
  enabled: boolean;
  ready: boolean;
  modelsExist: boolean;
  modelSize: string;
  version: string;
}

// ---------- 常量 ----------

const OCR_VERSION = 'PP-OCRv4';
const MODEL_DIR_NAME = 'ocr-models';
const DET_MODEL_FILE = 'ch_PP-OCRv4_det.onnx';
const REC_MODEL_FILE = 'ch_PP-OCRv4_rec.onnx';
const DICT_FILE = 'ppocr_keys_v1.txt';

/** 模型下载地址（npmmirror CDN / GitHub 回退） */
const MODEL_SOURCES = [
  'https://registry.npmmirror.com/@aspect-build/paddleocr-models/1.0.0/files',
  'https://github.com/aspect-build/paddleocr-models/releases/download/v1.0.0'
];

// ---------- 服务类 ----------

export class OcrService {
  private detSession: import('onnxruntime-node').InferenceSession | null = null;
  private recSession: import('onnxruntime-node').InferenceSession | null = null;
  private dict: string[] = [];
  private initializing = false;

  constructor(private db: Database) {}

  /** 模型存储目录 */
  private modelDir(): string {
    return join(app.getPath('userData'), 'aibox-data', MODEL_DIR_NAME);
  }

  /** 是否启用（读 settings 表） */
  isEnabled(): boolean {
    return this.db.getSetting<boolean>('ocr_enabled', false);
  }

  /** 设置启用/禁用 */
  setEnabled(enabled: boolean): void {
    this.db.setSetting('ocr_enabled', enabled);
    if (!enabled) this.dispose();
  }

  /** 模型文件是否已下载 */
  modelsExist(): boolean {
    const dir = this.modelDir();
    return existsSync(join(dir, DET_MODEL_FILE)) && existsSync(join(dir, REC_MODEL_FILE)) && existsSync(join(dir, DICT_FILE));
  }

  /** 获取服务状态 */
  getStatus(): OcrStatus {
    const dir = this.modelDir();
    let modelSize = '—';
    if (this.modelsExist()) {
      const detSize = readFileSync(join(dir, DET_MODEL_FILE)).length;
      const recSize = readFileSync(join(dir, REC_MODEL_FILE)).length;
      modelSize = `${((detSize + recSize) / 1024 / 1024).toFixed(1)} MB`;
    }
    return {
      enabled: this.isEnabled(),
      ready: this.detSession !== null && this.recSession !== null,
      modelsExist: this.modelsExist(),
      modelSize,
      version: OCR_VERSION
    };
  }

  /** 下载模型文件（首次使用时调用） */
  async downloadModels(): Promise<{ ok: boolean; message: string }> {
    const dir = this.modelDir();
    mkdirSync(dir, { recursive: true });

    const files = [DET_MODEL_FILE, REC_MODEL_FILE, DICT_FILE];
    for (const file of files) {
      const target = join(dir, file);
      if (existsSync(target)) continue;

      let downloaded = false;
      for (const base of MODEL_SOURCES) {
        try {
          const url = `${base}/${file}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 1024) continue; // 文件太小说明不是有效模型
          writeFileSync(target, buf);
          downloaded = true;
          break;
        } catch {
          continue; // 尝试下一个源
        }
      }
      if (!downloaded) {
        return { ok: false, message: `模型文件 ${file} 下载失败，请检查网络后重试` };
      }
    }
    return { ok: true, message: '模型下载完成' };
  }

  /** 初始化 ONNX Runtime 会话（懒加载） */
  async ensureReady(): Promise<void> {
    if (this.detSession && this.recSession) return;
    if (this.initializing) {
      // 等待另一个初始化完成
      await new Promise((r) => setTimeout(r, 500));
      return this.ensureReady();
    }
    if (!this.isEnabled()) throw new Error('OCR 服务未启用，请在设置中开启');
    if (!this.modelsExist()) {
      const r = await this.downloadModels();
      if (!r.ok) throw new Error(r.message);
    }

    this.initializing = true;
    try {
      const ort = await import('onnxruntime-node');
      const dir = this.modelDir();
      const sessOpts: import('onnxruntime-node').InferenceSession.SessionOptions = {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        interOpNumThreads: 1,
        intraOpNumThreads: 2
      };

      this.detSession = await ort.InferenceSession.create(join(dir, DET_MODEL_FILE), sessOpts);
      this.recSession = await ort.InferenceSession.create(join(dir, REC_MODEL_FILE), sessOpts);

      // 加载字典
      const dictPath = join(dir, DICT_FILE);
      const dictContent = readFileSync(dictPath, 'utf8');
      this.dict = dictContent.split('\n').map((l) => l.trim()).filter(Boolean);
      // PP-OCR 字典：index 0 对应空格（blank），最后加一个空格字符
      this.dict = [' ', ...this.dict, ' '];
    } finally {
      this.initializing = false;
    }
  }

  /** 识别图片中的文字 */
  async recognize(imagePath: string): Promise<OcrResult> {
    const start = Date.now();
    try {
      if (!existsSync(imagePath)) {
        return { ok: false, text: '', boxes: [], elapsed: 0, error: `文件不存在：${imagePath}` };
      }
      await this.ensureReady();

      const sharp = (await import('sharp')).default;
      const ort = await import('onnxruntime-node');

      // 1. 读取图片
      const imgBuf = readFileSync(imagePath);
      const image = sharp(imgBuf);
      const meta = await image.metadata();
      const origW = meta.width ?? 0;
      const origH = meta.height ?? 0;
      if (origW === 0 || origH === 0) {
        return { ok: false, text: '', boxes: [], elapsed: Date.now() - start, error: '无法读取图片尺寸' };
      }

      // 2. 文本检测
      const boxes = await this.detectText(ort, sharp, imgBuf, origW, origH);
      if (boxes.length === 0) {
        return { ok: true, text: '（未检测到文字）', boxes: [], elapsed: Date.now() - start };
      }

      // 3. 逐区域识别
      const results: OcrBox[] = [];
      for (const box of boxes) {
        const cropped = await this.cropRegion(sharp, imgBuf, box, origW, origH);
        if (!cropped) continue;
        const { text, confidence } = await this.recognizeText(ort, cropped);
        if (text.trim()) {
          results.push({ box, text: text.trim(), confidence });
        }
      }

      const fullText = results.map((r) => r.text).join('\n');
      return { ok: true, text: fullText, boxes: results, elapsed: Date.now() - start };
    } catch (err) {
      return {
        ok: false, text: '', boxes: [], elapsed: Date.now() - start,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  /** 文本检测：输出文字区域四点坐标 */
  private async detectText(
    ort: typeof import('onnxruntime-node'),
    _sharp: unknown,
    imgBuf: Buffer,
    origW: number,
    origH: number
  ): Promise<[number, number][][]> {
    if (!this.detSession) throw new Error('检测模型未加载');

    // 缩放到合适尺寸（长边不超过 960，保持比例，宽高对齐到 32 倍数）
    const maxSide = 960;
    let scale = 1;
    if (Math.max(origW, origH) > maxSide) {
      scale = maxSide / Math.max(origW, origH);
    }
    let detW = Math.round(origW * scale);
    let detH = Math.round(origH * scale);
    detW = Math.max(32, Math.round(detW / 32) * 32);
    detH = Math.max(32, Math.round(detH / 32) * 32);

    const sharpMod = (await import('sharp')).default;
    const resized = await sharpMod(imgBuf)
      .resize(detW, detH, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer();

    // 归一化：mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225]
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const float32Data = new Float32Array(3 * detH * detW);
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < detH; y++) {
        for (let x = 0; x < detW; x++) {
          const srcIdx = (y * detW + x) * 3 + c;
          const dstIdx = c * detH * detW + y * detW + x;
          float32Data[dstIdx] = (resized[srcIdx] / 255.0 - mean[c]) / std[c];
        }
      }
    }

    const inputTensor = new ort.Tensor('float32', float32Data, [1, 3, detH, detW]);
    const feeds: Record<string, typeof inputTensor> = {};
    const inputName = this.detSession.inputNames[0] ?? 'x';
    feeds[inputName] = inputTensor;

    const output = await this.detSession.run(feeds);
    const outputName = this.detSession.outputNames[0] ?? 'save_infer_model/scale_0.tmp_1';
    const probMap = output[outputName];
    if (!probMap) return [];

    // 解析概率图 → 二值化 → 连通域 → 最小外接矩形
    const probData = probMap.data as Float32Array;
    const boxes = this.parseDetBoxes(probData, detW, detH, origW / detW, origH / detH);
    return boxes;
  }

  /** 解析检测概率图为文字框 */
  private parseDetBoxes(
    prob: Float32Array, w: number, h: number,
    scaleX: number, scaleY: number
  ): [number, number][][] {
    const threshold = 0.3;
    const minArea = 10;
    // 二值化
    const binary = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      binary[i] = prob[i] > threshold ? 1 : 0;
    }

    // 简单连通域标记（BFS）
    const visited = new Uint8Array(w * h);
    const boxes: [number, number][][] = [];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (binary[idx] === 0 || visited[idx]) continue;

        // BFS 找连通域
        const queue: number[] = [idx];
        visited[idx] = 1;
        let minX = x, maxX = x, minY = y, maxY = y;
        let area = 0;

        while (queue.length > 0) {
          const cur = queue.pop()!;
          const cx = cur % w;
          const cy = Math.floor(cur / w);
          area++;
          minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);

          // 4 邻域
          const neighbors = [
            cy > 0 ? cur - w : -1,
            cy < h - 1 ? cur + w : -1,
            cx > 0 ? cur - 1 : -1,
            cx < w - 1 ? cur + 1 : -1
          ];
          for (const n of neighbors) {
            if (n >= 0 && binary[n] === 1 && !visited[n]) {
              visited[n] = 1;
              queue.push(n);
            }
          }
        }

        if (area < minArea) continue;
        // 过滤过窄/过矮区域
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        if (bw < 3 || bh < 3) continue;

        // 还原到原图坐标
        const box: [number, number][] = [
          [Math.round(minX * scaleX), Math.round(minY * scaleY)],
          [Math.round((maxX + 1) * scaleX), Math.round(minY * scaleY)],
          [Math.round((maxX + 1) * scaleX), Math.round((maxY + 1) * scaleY)],
          [Math.round(minX * scaleX), Math.round((maxY + 1) * scaleY)]
        ];
        boxes.push(box);
      }
    }

    // 按 Y 坐标排序（从上到下，从左到右）
    boxes.sort((a, b) => {
      const dy = a[0][1] - b[0][1];
      if (Math.abs(dy) > 10) return dy;
      return a[0][0] - b[0][0];
    });
    return boxes;
  }

  /** 裁剪文字区域（透视校正简化为矩形裁剪） */
  private async cropRegion(
    _sharp: unknown,
    imgBuf: Buffer,
    box: [number, number][],
    _origW: number,
    _origH: number
  ): Promise<Buffer | null> {
    try {
      const sharpMod = (await import('sharp')).default;
      const xs = box.map((p) => p[0]);
      const ys = box.map((p) => p[1]);
      const left = Math.max(0, Math.min(...xs));
      const top = Math.max(0, Math.min(...ys));
      const right = Math.max(...xs);
      const bottom = Math.max(...ys);
      const width = right - left;
      const height = bottom - top;
      if (width < 3 || height < 3) return null;

      const cropped = await sharpMod(imgBuf)
        .extract({ left, top, width, height })
        .toBuffer();
      return cropped;
    } catch {
      return null;
    }
  }

  /** 文本识别：对裁剪后的区域进行文字识别 */
  private async recognizeText(
    ort: typeof import('onnxruntime-node'),
    imgBuf: Buffer
  ): Promise<{ text: string; confidence: number }> {
    if (!this.recSession) throw new Error('识别模型未加载');

    const sharpMod = (await import('sharp')).default;
    const meta = await sharpMod(imgBuf).metadata();
    const srcW = meta.width ?? 0;
    const srcH = meta.height ?? 0;
    if (srcW === 0 || srcH === 0) return { text: '', confidence: 0 };

    // 识别模型输入：高度固定 48，宽度按比例缩放（最大 320）
    const recH = 48;
    let recW = Math.round(srcW * (recH / srcH));
    recW = Math.min(Math.max(recW, 48), 320);

    const resized = await sharpMod(imgBuf)
      .resize(recW, recH, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer();

    // 归一化：mean=[0.5,0.5,0.5], std=[0.5,0.5,0.5]
    const float32Data = new Float32Array(3 * recH * recW);
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < recH; y++) {
        for (let x = 0; x < recW; x++) {
          const srcIdx = (y * recW + x) * 3 + c;
          const dstIdx = c * recH * recW + y * recW + x;
          float32Data[dstIdx] = (resized[srcIdx] / 255.0 - 0.5) / 0.5;
        }
      }
    }

    const inputTensor = new ort.Tensor('float32', float32Data, [1, 3, recH, recW]);
    const feeds: Record<string, typeof inputTensor> = {};
    const inputName = this.recSession.inputNames[0] ?? 'x';
    feeds[inputName] = inputTensor;

    const output = await this.recSession.run(feeds);
    const outputName = this.recSession.outputNames[0] ?? 'save_infer_model/scale_0.tmp_1';
    const logits = output[outputName];
    if (!logits) return { text: '', confidence: 0 };

    // CTC 解码
    return this.ctcDecode(logits.data as Float32Array, logits.dims as number[]);
  }

  /** CTC 贪心解码 */
  private ctcDecode(data: Float32Array, dims: number[]): { text: string; confidence: number } {
    // dims: [1, seqLen, numClasses]
    const seqLen = dims[1] ?? 0;
    const numClasses = dims[2] ?? 0;
    if (seqLen === 0 || numClasses === 0) return { text: '', confidence: 0 };

    let text = '';
    let totalConf = 0;
    let charCount = 0;
    let prevIdx = -1;

    for (let t = 0; t < seqLen; t++) {
      // 找最大概率类别
      let maxIdx = 0;
      let maxVal = -Infinity;
      for (let c = 0; c < numClasses; c++) {
        const val = data[t * numClasses + c];
        if (val > maxVal) { maxVal = val; maxIdx = c; }
      }

      // CTC: 跳过 blank（index 0）和重复
      if (maxIdx !== 0 && maxIdx !== prevIdx) {
        const char = this.dict[maxIdx] ?? '';
        if (char) {
          text += char;
          totalConf += maxVal;
          charCount++;
        }
      }
      prevIdx = maxIdx;
    }

    return { text, confidence: charCount > 0 ? totalConf / charCount : 0 };
  }

  /** 释放模型资源 */
  dispose(): void {
    if (this.detSession) { void this.detSession.release(); this.detSession = null; }
    if (this.recSession) { void this.recSession.release(); this.recSession = null; }
    this.dict = [];
  }
}
