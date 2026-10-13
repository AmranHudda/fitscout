import { uploadKeyOk, uploadStats } from "@/lib/uploads";
import { Uploader } from "./uploader";
import "./upload.css";

export async function UploadScreen({ uploadKey }: { uploadKey: string | undefined }) {
  if (!uploadKey || !uploadKeyOk(uploadKey)) {
    return (
      <main className="up">
        <p className="eyebrow">fitscout</p>
        <h1>This link isn&apos;t valid.</h1>
        <p className="lede">Check that the whole link came through, or scan the QR code from `npm run upload:link`.</p>
      </main>
    );
  }
  const stats = await uploadStats();
  return (
    <Uploader
      uploadKey={uploadKey}
      initial={{
        photos: stats.photos,
        garments: stats.garments,
        builtFrom: stats.builtFrom,
        brief: stats.taste.brief,
        pillars: stats.taste.pillars.map((p) => ({ name: p.name, description: p.description })),
        sizes: { tops: stats.taste.sizes.tops ?? "", bottoms: stats.taste.sizes.bottoms ?? "", shoes: stats.taste.sizes.shoes ?? "", baggy: !!stats.taste.sizes.baggy },
        budget: stats.taste.budget,
        location: { zip: stats.taste.location.zip ?? "", radiusMi: stats.taste.location.radiusMi },
        groups: stats.groups,
        brands: stats.taste.myBrands ?? [],
      }}
    />
  );
}
