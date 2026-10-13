import { UploadScreen } from "./screen";

export const metadata = { title: "fitscout · add photos" };

export default async function UploadPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const k = (await searchParams).k;
  return <UploadScreen uploadKey={typeof k === "string" ? k : undefined} />;
}
