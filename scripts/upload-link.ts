// Prints the private photo-upload link and a QR code to scan with your phone's camera.
// Also writes upload-qr.png (gitignored). Usage: npm run upload:link
import "./env";
import QRCode from "qrcode";
import { config } from "../lib/config";
import { uploadLink } from "../lib/uploads";

if (!config.token) {
  console.error("FITSCOUT_TOKEN is not set in .env.local.");
  process.exit(1);
}
const link = uploadLink();
console.log(await QRCode.toString(link, { type: "terminal", small: true }));
await QRCode.toFile("upload-qr.png", link, { width: 512, margin: 2 });
console.log(`${link}\n\nAlso saved upload-qr.png (open it and scan with your phone camera).`);
