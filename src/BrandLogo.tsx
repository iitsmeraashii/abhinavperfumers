// Branch-local branding: intentionally independent of the shared deployment's
// VITE_APP_NAME / VITE_LOGO_URL so client settings cannot leak into this demo.
export default function BrandLogo({ large = false }: { large?: boolean }) {
  return <img src="/becoso-logo.png" alt="BecosoWebCo"
    className={`${large ? 'w-72 h-24 mx-auto' : 'w-44 h-14'} max-w-full rounded-lg object-cover`}
    width={large ? 288 : 176} height={large ? 96 : 56} />;
}
