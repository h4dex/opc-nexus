#!/usr/bin/env python3
"""
图片处理工具 - AiBoxDash 本地工具集
支持: 缩放、裁剪、格式转换、旋转、加水印、获取信息、批量处理

用法:
  python image_tool.py --action <info|resize|crop|convert|rotate|watermark|thumbnail|batch_resize> --input <文件> [选项]

输出: JSON 格式
依赖: pip install Pillow
"""
import argparse
import json
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


def check_pil() -> dict | None:
    if not HAS_PIL:
        return {"ok": False, "error": "需要安装 Pillow: pip install Pillow"}
    return None


def get_info(input_path: str) -> dict:
    """获取图片信息"""
    err = check_pil()
    if err:
        return err
    try:
        img = Image.open(input_path)
        info = {
            "ok": True,
            "path": str(Path(input_path).resolve()),
            "format": img.format,
            "mode": img.mode,
            "width": img.width,
            "height": img.height,
            "size_bytes": Path(input_path).stat().st_size,
        }
        # EXIF 信息
        exif = img.getexif()
        if exif:
            exif_data = {}
            tags = {271: "Make", 272: "Model", 306: "DateTime", 274: "Orientation"}
            for tag_id, name in tags.items():
                if tag_id in exif:
                    exif_data[name] = str(exif[tag_id])
            if exif_data:
                info["exif"] = exif_data
        return info
    except Exception as e:
        return {"ok": False, "error": f"打开图片失败: {e}"}


def resize_image(input_path: str, output_path: str = None,
                 width: int = None, height: int = None, quality: int = 85) -> dict:
    """缩放图片（保持比例）"""
    err = check_pil()
    if err:
        return err
    try:
        img = Image.open(input_path)
        orig_w, orig_h = img.size

        if width and height:
            new_size = (width, height)
        elif width:
            ratio = width / orig_w
            new_size = (width, int(orig_h * ratio))
        elif height:
            ratio = height / orig_h
            new_size = (int(orig_w * ratio), height)
        else:
            return {"ok": False, "error": "需要指定 --width 或 --height"}

        resized = img.resize(new_size, Image.LANCZOS)
        out = Path(output_path) if output_path else Path(input_path).with_stem(Path(input_path).stem + "_resized")
        resized.save(str(out), quality=quality)
        return {"ok": True, "output": str(out.resolve()), "original": f"{orig_w}x{orig_h}", "resized": f"{new_size[0]}x{new_size[1]}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def crop_image(input_path: str, output_path: str = None,
               left: int = 0, top: int = 0, right: int = None, bottom: int = None) -> dict:
    """裁剪图片"""
    err = check_pil()
    if err:
        return err
    try:
        img = Image.open(input_path)
        w, h = img.size
        right = right or w
        bottom = bottom or h
        cropped = img.crop((left, top, right, bottom))
        out = Path(output_path) if output_path else Path(input_path).with_stem(Path(input_path).stem + "_cropped")
        cropped.save(str(out))
        return {"ok": True, "output": str(out.resolve()), "crop_box": [left, top, right, bottom], "size": f"{right-left}x{bottom-top}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def convert_image(input_path: str, output_format: str = "png", output_path: str = None, quality: int = 85) -> dict:
    """格式转换（png/jpg/webp/bmp/gif）"""
    err = check_pil()
    if err:
        return err
    try:
        img = Image.open(input_path)
        # RGBA 转 JPG 需要白底
        if output_format.lower() in ("jpg", "jpeg") and img.mode == "RGBA":
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[3])
            img = bg

        out = Path(output_path) if output_path else Path(input_path).with_suffix(f".{output_format}")
        save_kwargs = {"quality": quality} if output_format.lower() in ("jpg", "jpeg", "webp") else {}
        img.save(str(out), **save_kwargs)
        return {"ok": True, "output": str(out.resolve()), "format": output_format, "size_bytes": out.stat().st_size}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def rotate_image(input_path: str, angle: float = 90, output_path: str = None) -> dict:
    """旋转图片"""
    err = check_pil()
    if err:
        return err
    try:
        img = Image.open(input_path)
        rotated = img.rotate(-angle, expand=True)  # 顺时针
        out = Path(output_path) if output_path else Path(input_path).with_stem(Path(input_path).stem + f"_rot{int(angle)}")
        rotated.save(str(out))
        return {"ok": True, "output": str(out.resolve()), "angle": angle, "new_size": f"{rotated.width}x{rotated.height}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def add_watermark(input_path: str, text: str = "AiBoxDash", output_path: str = None,
                  opacity: int = 80, position: str = "bottom-right") -> dict:
    """添加文字水印"""
    err = check_pil()
    if err:
        return err
    try:
        img = Image.open(input_path).convert("RGBA")
        txt_layer = Image.new("RGBA", img.size, (255, 255, 255, 0))
        draw = ImageDraw.Draw(txt_layer)

        # 字体大小自适应
        font_size = max(16, img.width // 20)
        try:
            font = ImageFont.truetype("arial.ttf", font_size)
        except (IOError, OSError):
            font = ImageFont.load_default()

        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        margin = 20

        positions = {
            "top-left": (margin, margin),
            "top-right": (img.width - tw - margin, margin),
            "bottom-left": (margin, img.height - th - margin),
            "bottom-right": (img.width - tw - margin, img.height - th - margin),
            "center": ((img.width - tw) // 2, (img.height - th) // 2),
        }
        pos = positions.get(position, positions["bottom-right"])
        draw.text(pos, text, font=font, fill=(255, 255, 255, opacity))

        result = Image.alpha_composite(img, txt_layer)
        out = Path(output_path) if output_path else Path(input_path).with_stem(Path(input_path).stem + "_wm")
        result.convert("RGB").save(str(out))
        return {"ok": True, "output": str(out.resolve()), "watermark": text, "position": position}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def make_thumbnail(input_path: str, size: int = 200, output_path: str = None) -> dict:
    """生成缩略图"""
    err = check_pil()
    if err:
        return err
    try:
        img = Image.open(input_path)
        img.thumbnail((size, size), Image.LANCZOS)
        out = Path(output_path) if output_path else Path(input_path).with_stem(Path(input_path).stem + f"_thumb{size}")
        img.save(str(out))
        return {"ok": True, "output": str(out.resolve()), "size": f"{img.width}x{img.height}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def batch_resize(input_dir: str, width: int = 800, output_dir: str = None, quality: int = 85) -> dict:
    """批量缩放目录下所有图片"""
    err = check_pil()
    if err:
        return err

    dir_path = Path(input_dir)
    if not dir_path.is_dir():
        return {"ok": False, "error": f"目录不存在: {input_dir}"}

    out_dir = Path(output_dir) if output_dir else dir_path / "resized"
    out_dir.mkdir(parents=True, exist_ok=True)

    exts = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
    processed = 0
    errors = []

    for f in sorted(dir_path.iterdir()):
        if f.suffix.lower() not in exts:
            continue
        try:
            img = Image.open(f)
            if img.width > width:
                ratio = width / img.width
                new_h = int(img.height * ratio)
                img = img.resize((width, new_h), Image.LANCZOS)
            save_kwargs = {"quality": quality} if f.suffix.lower() in (".jpg", ".jpeg", ".webp") else {}
            img.save(str(out_dir / f.name), **save_kwargs)
            processed += 1
        except Exception as e:
            errors.append(f"{f.name}: {e}")

    return {"ok": True, "output_dir": str(out_dir.resolve()), "processed": processed, "errors": errors[:10]}


def main():
    parser = argparse.ArgumentParser(description="图片处理工具")
    parser.add_argument("--action", required=True,
                        choices=["info", "resize", "crop", "convert", "rotate", "watermark", "thumbnail", "batch_resize"],
                        help="操作类型")
    parser.add_argument("--input", required=True, help="输入文件/目录路径")
    parser.add_argument("--output", default=None, help="输出路径")
    parser.add_argument("--width", type=int, default=None, help="目标宽度")
    parser.add_argument("--height", type=int, default=None, help="目标高度")
    parser.add_argument("--quality", type=int, default=85, help="输出质量（1-100）")
    parser.add_argument("--format", default="png", help="转换目标格式")
    parser.add_argument("--angle", type=float, default=90, help="旋转角度")
    parser.add_argument("--text", default="AiBoxDash", help="水印文字")
    parser.add_argument("--position", default="bottom-right", help="水印位置")
    parser.add_argument("--size", type=int, default=200, help="缩略图尺寸")
    parser.add_argument("--left", type=int, default=0, help="裁剪左边界")
    parser.add_argument("--top", type=int, default=0, help="裁剪上边界")
    parser.add_argument("--right", type=int, default=None, help="裁剪右边界")
    parser.add_argument("--bottom", type=int, default=None, help="裁剪下边界")
    args = parser.parse_args()

    actions = {
        "info": lambda: get_info(args.input),
        "resize": lambda: resize_image(args.input, args.output, args.width, args.height, args.quality),
        "crop": lambda: crop_image(args.input, args.output, args.left, args.top, args.right, args.bottom),
        "convert": lambda: convert_image(args.input, args.format, args.output, args.quality),
        "rotate": lambda: rotate_image(args.input, args.angle, args.output),
        "watermark": lambda: add_watermark(args.input, args.text, args.output, position=args.position),
        "thumbnail": lambda: make_thumbnail(args.input, args.size, args.output),
        "batch_resize": lambda: batch_resize(args.input, args.width or 800, args.output, args.quality),
    }

    result = actions[args.action]()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
