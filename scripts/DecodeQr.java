import com.google.zxing.BinaryBitmap;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.DecodeHintType;
import com.google.zxing.LuminanceSource;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.common.HybridBinarizer;
import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Graphics2D;
import java.io.File;
import java.util.EnumMap;
import java.util.List;

public final class DecodeQr {
    private DecodeQr() {}

    private static final class ImageLuminanceSource extends LuminanceSource {
        private final byte[] luminances;

        ImageLuminanceSource(java.awt.image.BufferedImage image) {
            super(image.getWidth(), image.getHeight());
            luminances = new byte[getWidth() * getHeight()];
            for (int y = 0; y < getHeight(); y++) {
                for (int x = 0; x < getWidth(); x++) {
                    int rgb = image.getRGB(x, y);
                    int red = (rgb >> 16) & 0xff;
                    int green = (rgb >> 8) & 0xff;
                    int blue = rgb & 0xff;
                    luminances[y * getWidth() + x] = (byte) ((red + 2 * green + blue) / 4);
                }
            }
        }

        @Override
        public byte[] getRow(int y, byte[] row) {
            if (y < 0 || y >= getHeight()) throw new IllegalArgumentException("row outside image");
            if (row == null || row.length < getWidth()) row = new byte[getWidth()];
            System.arraycopy(luminances, y * getWidth(), row, 0, getWidth());
            return row;
        }

        @Override
        public byte[] getMatrix() {
            return luminances.clone();
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("usage: DecodeQr <png>");
        var image = ImageIO.read(new File(args[0]));
        if (image == null) throw new IllegalArgumentException("input is not a supported image");
        int quietZone = Math.max(32, Math.min(image.getWidth(), image.getHeight()) / 16);
        var padded = new java.awt.image.BufferedImage(
            image.getWidth() + quietZone * 2,
            image.getHeight() + quietZone * 2,
            java.awt.image.BufferedImage.TYPE_INT_RGB
        );
        Graphics2D graphics = padded.createGraphics();
        graphics.setColor(Color.WHITE);
        graphics.fillRect(0, 0, padded.getWidth(), padded.getHeight());
        graphics.drawImage(image, quietZone, quietZone, null);
        graphics.dispose();

        var bitmap = new BinaryBitmap(new HybridBinarizer(new ImageLuminanceSource(padded)));
        var hints = new EnumMap<DecodeHintType, Object>(DecodeHintType.class);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, List.of(BarcodeFormat.QR_CODE));
        System.out.print(new MultiFormatReader().decode(bitmap, hints).getText());
    }
}
