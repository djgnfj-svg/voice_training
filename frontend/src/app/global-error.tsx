'use client';

export default function GlobalError({
  reset,
}: {
  reset: () => void;
}) {
  return (
    <html lang="ko">
      <body className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="mx-auto max-w-md space-y-4 text-center">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            오류가 발생했습니다
          </h2>
          <p className="text-gray-600 dark:text-gray-400">
            예상치 못한 오류가 발생했습니다. 다시 시도해주세요.
          </p>
          <button
            onClick={reset}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            다시 시도
          </button>
        </div>
      </body>
    </html>
  );
}
