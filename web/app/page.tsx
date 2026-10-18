import { Suspense } from "react";
import { devLoginEnabled, kakaoConfigured } from "@/lib/auth";

const ERRORS: Record<string, string> = {
  kakao_not_configured: "카카오 앱 키가 설정되지 않았습니다. .env.local 의 KAKAO_REST_API_KEY 를 채워 주세요.",
  kakao_denied: "카카오 로그인이 취소되었습니다.",
  invalid_state: "로그인 요청이 만료되었습니다. 다시 시도해 주세요.",
  token_failed: "카카오 인증에 실패했습니다. 앱 키와 Redirect URI 설정을 확인하세요.",
  profile_failed: "카카오 프로필을 불러오지 못했습니다.",
};

async function LoginError({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const { error } = await searchParams;
  const message = typeof error === "string" ? ERRORS[error] : undefined;
  if (!message) return null;
  return <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{message}</p>;
}

export default function LoginPage({ searchParams }: PageProps<"/">) {
  const showDevLogin = devLoginEnabled();
  const kakaoReady = kakaoConfigured();

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-kakao text-2xl" aria-hidden>
            💬
          </div>
          <h1 className="text-2xl font-bold">단체톡 관리</h1>
          <p className="text-sm text-muted">친구 그룹을 정리하고, 이름이 들어간 메시지를 한 번에 준비하세요.</p>
        </div>

        <div className="card space-y-3 p-5">
          <Suspense>
            <LoginError searchParams={searchParams} />
          </Suspense>

          <a href="/auth/kakao" className={`btn btn-kakao w-full py-3 text-base ${kakaoReady ? "" : "opacity-50"}`}>
            카카오로 시작하기
          </a>
          {!kakaoReady && (
            <p className="text-xs text-muted">카카오 앱 키를 아직 넣지 않았습니다. README 의 &ldquo;카카오 로그인 설정&rdquo;을 참고하세요.</p>
          )}

          {showDevLogin && (
            <form action="/auth/dev" method="post">
              <button type="submit" className="btn w-full">
                테스트 계정으로 둘러보기 (개발용)
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
