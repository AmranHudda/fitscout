import { UploadScreen } from "@/app/upload/screen";

export const metadata = { title: "fitscout · add photos" };

// Short form of the upload link: /u/<key>.
export default async function ShortUploadPage({ params }: { params: Promise<{ key: string }> }) {
  return <UploadScreen uploadKey={(await params).key} />;
}
