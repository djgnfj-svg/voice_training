# Prompt Cache 적중률 실측 (2026-04-28)

## 목적
포트폴리오 카피의 "1세션 LLM 비용 절감" 수치 검증. OpenAI 자동 prompt caching이 실제로 적중하는지, 1세션 비용 절감률이 얼마인지 실측.

## 측정 대상
- 모델: `gpt-4o-mini`
- 메시지 구조 (`backend/app/lib/llm_client.py:_build_cached_messages`):
  1. `system` — 페르소나 + 출력 포맷 지시 (고정)
  2. `user` (cached_context) — 루브릭 + 페르소나 + 이력서 청크 + JD + scan plan (세션 불변)
  3. `assistant` ack — `"Understood. Ready for turn-specific input."`
  4. `user` (variable) — 턴별 phase/idx/직전 depth 입력
- 시나리오: 1 면접 세션 = Scan 3턴 + Dive 4턴 = **7 LLM 호출**, prefix(1+2+3) 고정.

## 측정 방법
스크립트: `scripts/measure_prompt_cache.py`

```
docker cp scripts/measure_prompt_cache.py voice_training-backend-1:/tmp/work/
docker compose exec -e E2E_MOCK_LLM=0 backend python /tmp/work/measure_prompt_cache.py
```

각 호출에서 `response.usage.prompt_tokens_details.cached_tokens` 수집 후 합산.

## 결과

| turn | prompt | cached | completion | latency |
|------|-------:|-------:|-----------:|--------:|
| 0    |  1057  |     0  |     60     | 4659 ms |
| 1    |  1065  |     0  |     67     | 3301 ms |
| 2    |  1063  |     0  |     46     | 2044 ms |
| 3    |  1067  |     0  |     49     | 1842 ms |
| 4    |  1071  |  1024  |     84     | 2131 ms |
| 5    |  1063  |     0  |     66     | 2274 ms |
| 6    |  1069  |  1024  |     78     | 4182 ms |
| **합** | **7455** | **2048** | **450** | — |

- **Cache hit ratio (input 토큰 기준): 27.5%**
- 7턴 중 **2턴이 캐시 적중** (turn 4, 6)

## 비용 계산
gpt-4o-mini 단가 (USD/1M tokens): input $0.15, cached input $0.075, output $0.60.

| 항목 | 비용 |
|------|-----:|
| 캐시 미적용 | $0.001388 |
| 캐시 적용   | $0.001235 |
| **세션 절감률** | **11.1%** |

## 해석
- OpenAI 자동 캐시는 prefix가 1024 토큰 이상이고 동일할 때 적중. 측정한 prefix는 ~1050 토큰으로 임계값 바로 위.
- 호출이 짧은 간격(수 초)으로 이어졌음에도 모든 턴이 적중하지는 않음. 캐시 워밍 시점/내부 라우팅에 따라 hit/miss가 갈리는 것으로 보임.
- "최대 22%" 같은 마케팅 수치 대신 **실측 11%** 사용. 캐시 적중률은 prefix 길이·세션 길이·호출 빈도가 늘수록 올라감.

## 후속 개선 여지
- prefix를 2~3k 토큰까지 키우면 캐시 적중 시 절감 폭 ↑ (input 50% 할인이 큰 비중을 먹음).
- 호출 간격이 멀어지면 캐시 만료. 동일 세션 내 호출은 보통 안전.
- 실제 운영 트래픽에서 `cached_tokens / prompt_tokens` 메트릭을 누적 집계하면 진짜 평균치를 얻을 수 있음 (이미 `llm_client._emit_metric`에 필드 들어가 있음).
