# ZK Community - On-Chain Recording Feature Specification

## 배경: 왜 이렇게 설계했는가

### Vitalik의 관점 (2026.03 Real World Crypto)

Vitalik은 블록체인의 역할을 4가지로 정리했다:

1. **Public Bulletin Board** -- 누구나 읽고 쓸 수 있는 공개 기록 공간. 투표, 인증서 관리, 소프트웨어 버전 관리 등에 필요.
2. **Payments** -- 스팸 방지와 서비스 제공자 보상. "permissionless API가 스팸으로 죽지 않으려면 결제가 필요하다."
3. **Sybil Resistance** -- 프라이버시와 보안을 중시한다면 전화번호 의존 없이 permissionless하게. ETH 결제가 자연스러운 anti-sybil 도구.
4. **Smart Contracts** -- 보증금, 결제 채널, 디지털 오브젝트 간 상호작용.

핵심 메시지: **"이더리움의 유즈케이스를 찾으러 다니지 마라. CROPS(censorship-resistant, open-source, private, secure) 기술 스택에서 기술이 자연스럽게 맞는 곳에 쓰라."**

> 원문: https://vitalik.eth.limo/general/2026/03/12/ethfuture.html

### ZK Community에 대한 적용 원칙

우리는 블록체인을 **자연스럽게 맞는 곳에만** 사용한다:

| 블록체인이 맞는 곳                         | 블록체인이 맞지 않는 곳      |
| ------------------------------------------ | ---------------------------- |
| 로그인 (ZK proof = sybil resistance)       | 글쓰기, 댓글 (DB로 충분)     |
| 중요한 콘텐츠의 영구 기록 (bulletin board) | 좋아요, 리액션 (가스비 낭비) |
| 결제가 필요한 곳 (anti-spam)               | 일반 커뮤니티 상호작용       |

**블록체인을 억지로 넣은 커뮤니티**가 아니라, **CROPS 원칙이 자연스럽게 적용된 커뮤니티**를 만든다.

---

## 서비스 구조 개요

```
ZK Community

[접근] ZK Proof Gate (Sybil Resistance)
  - Coinbase KYC ZK proof로 로그인
  - 1인 1계정 (nullifier = 고유 ID)
  - 인간과 AI 에이전트 동일 자격
  - 프라이버시 보존 (신원 비노출)

[활동] Off-chain Community (DB)
  - 토픽 생성/참여
  - 글쓰기, 댓글, 좋아요, 리액션
  - 국가별 접근 제한 토픽 (Country proof)

[기록] On-chain Recording (Bulletin Board)  <-- 새 기능
  - 유저가 타인의 글을 온체인에 영구 기록
  - content hash만 올라감 (원문 아님)
  - Base TX 자연 발생

[관리] Moderation
  - 신고, AI 필터, nullifier 기반 영구 밴
```

---

## 새 기능: On-chain Recording

### 컨셉

커뮤니티의 글은 평소에 off-chain(DB)에 존재한다. 유저는 타인이 작성한 글을 **온체인에 영구 기록**할 수 있다. 이는 "좋아요"가 아니라 **"이 내용이 이 시점에 존재했다"는 증명**이다.

기록 동기는 두 가지:

- 긍정적: "이 분석은 영구히 남길 가치가 있다"
- 부정적: "이 사람이 이 시점에 이런 주장을 했다는 기록을 남긴다"

따라서 기록은 보상이 아니며, 글쓴이에게 돈이 가지 않는다.

### 왜 온체인인가 (Vitalik의 bulletin board)

Vitalik: "lots of cryptographic protocols require some publicly writable and readable place where people can post blobs of data."

이 커뮤니티는 전원 익명이다. 트위터처럼 "@계정"을 스크린샷 찍을 수 없다. 온체인 hash가 **"이 nullifier가 이 시점에 이 내용을 말했다"의 유일한 검증 가능 증명 수단**이다.

### On-chain에 기록되는 데이터

```solidity
struct Record {
    bytes32 contentHash;       // keccak256(글 내용)
    bytes32 authorNullifier;   // 글쓴이의 nullifier
    bytes32 recorderNullifier; // 기록한 사람의 nullifier
    uint256 timestamp;         // block.timestamp
    string  postId;            // 서비스 내부 참조 ID
}
```

원문 자체는 온체인에 올라가지 않음. hash만 기록. 원문은 서비스 DB에 존재하며, hash로 "이 내용이 변조되지 않았다"를 검증 가능.

---

## 기록 플로우

### 방법 1: 서비스 대행 (유저 비용 없음)

```
유저 B: "Record on-chain" 버튼 클릭
  |
  v
서비스 백엔드:
  1. 검증: 글이 존재하는가? B가 로그인 상태인가? 자기 글이 아닌가?
  2. 제한: B의 오늘 기록 횟수 < 일일 한도?
  3. 기록 조건: 글 작성 후 N시간 경과? 신고 N건 이상 아닌가?
  4. hash 계산: keccak256(글 내용)
  5. TX 제출: 서비스 백엔드 지갑 -> RecordBoard 컨트랙트
  |
  v
컨트랙트:
  - onlyService modifier (서비스 지갑만 호출 가능)
  - Record 저장
  - 이벤트 emit
  |
  v
서비스:
  - 해당 글에 "Recorded on Base" 배지 표시
  - TX hash 링크 연결
```

### 방법 2: 유저 직접 호출 (유저가 가스비 부담)

```
유저 B: "Record on-chain (Direct)" 선택
  |
  v
서비스 백엔드:
  1. 동일한 검증 수행
  2. 서비스 서명 발급: sign(contentHash, authorNullifier, postId, expiry)
  |
  v
유저 B:
  1. 지갑 연결 (MetaMask 등)
  2. TX 제출: RecordBoard.recordDirect(contentHash, ..., serviceSignature)
  3. 가스비 B가 부담
  |
  v
컨트랙트:
  - 서비스 서명 검증 (ecrecover)
  - 서명 없으면 revert -> 무단 호출 방지
  - Record 저장
  - 이벤트 emit
```

### UI

글 하단에 작은 버튼: **"Record on-chain"**

클릭 시 선택지:

```
[Record on Base] (Free, via service)
[Record directly] (Connect wallet, you pay gas)
```

기록 완료 후 글에 표시:

```
Recorded on Base | 3 records | View TX ->
```

---

## 컨트랙트 스펙

### RecordBoard.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract RecordBoard {

    struct Record {
        bytes32 contentHash;
        bytes32 authorNullifier;
        bytes32 recorderNullifier;
        uint256 timestamp;
    }

    address public service;  // 서비스 백엔드 지갑

    // postId => Record[]
    mapping(string => Record[]) public records;

    // 중복 방지: postId + recorderNullifier => recorded
    mapping(bytes32 => bool) public hasRecorded;

    uint256 public totalRecords;

    event ContentRecorded(
        string indexed postId,
        bytes32 contentHash,
        bytes32 authorNullifier,
        bytes32 recorderNullifier,
        uint256 timestamp
    );

    modifier onlyService() {
        require(msg.sender == service, "Not authorized");
        _;
    }

    constructor(address _service) {
        service = _service;
    }

    /// 방법 1: 서비스가 대행 호출
    function record(
        string calldata postId,
        bytes32 contentHash,
        bytes32 authorNullifier,
        bytes32 recorderNullifier
    ) external onlyService {
        _record(postId, contentHash, authorNullifier, recorderNullifier);
    }

    /// 방법 2: 유저가 직접 호출 (서비스 서명 필요)
    function recordDirect(
        string calldata postId,
        bytes32 contentHash,
        bytes32 authorNullifier,
        bytes32 recorderNullifier,
        uint256 expiry,
        bytes calldata serviceSignature
    ) external {
        require(block.timestamp <= expiry, "Signature expired");

        // 서비스 서명 검증
        bytes32 digest = keccak256(abi.encodePacked(
            postId, contentHash, authorNullifier, recorderNullifier, expiry
        ));
        bytes32 ethSignedHash = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32", digest
        ));
        address signer = _recover(ethSignedHash, serviceSignature);
        require(signer == service, "Invalid service signature");

        _record(postId, contentHash, authorNullifier, recorderNullifier);
    }

    function _record(
        string calldata postId,
        bytes32 contentHash,
        bytes32 authorNullifier,
        bytes32 recorderNullifier
    ) internal {
        // 동일인 중복 기록 방지
        bytes32 key = keccak256(abi.encodePacked(postId, recorderNullifier));
        require(!hasRecorded[key], "Already recorded by this user");
        hasRecorded[key] = true;

        // 자기 글 기록 방지
        require(authorNullifier != recorderNullifier, "Cannot record own post");

        records[postId].push(Record({
            contentHash: contentHash,
            authorNullifier: authorNullifier,
            recorderNullifier: recorderNullifier,
            timestamp: block.timestamp
        }));

        totalRecords++;

        emit ContentRecorded(
            postId, contentHash, authorNullifier, recorderNullifier, block.timestamp
        );
    }

    /// 조회: 특정 글의 기록 수
    function getRecordCount(string calldata postId) external view returns (uint256) {
        return records[postId].length;
    }

    /// ECDSA recover (simplified)
    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "Invalid signature");
        bytes32 r = bytes32(sig[:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        return ecrecover(hash, v, r, s);
    }
}
```

---

## 정책 규칙

### 기록 제한

| 규칙                      | 값        | 이유                                             |
| ------------------------- | --------- | ------------------------------------------------ |
| 자기 글 기록              | 불가      | 셀프 기록은 무의미. 타인의 평가만 가치 있음.     |
| 1인당 일일 한도           | 3건/일    | 남발 방지. 신중한 선택 유도.                     |
| 동일 글 중복 기록         | 불가      | 같은 사람이 같은 글 여러 번 기록할 이유 없음.    |
| 글 작성 후 최소 경과 시간 | 1시간     | 즉흥적 기록 방지. 커뮤니티가 내용 확인할 시간.   |
| 신고 N건 이상 글          | 기록 불가 | 이미 문제 제기된 글은 온체인 기록 대상에서 제외. |
| 삭제/숨김 처리된 글       | 기록 불가 | 모더레이션된 글은 대상 제외.                     |

### 수수료

| 방법        | 유저 비용           | 서비스 비용                 |
| ----------- | ------------------- | --------------------------- |
| 서비스 대행 | 무료 (초기)         | ~0.001 USD/건 (Base L2 gas) |
| 유저 직접   | 가스비 (~0.001 USD) | 0                           |

초기에는 서비스 대행을 무료로 운영한다. Base L2 가스비가 매우 저렴하므로 (월 1000건 = ~1 USD), 마케팅/운영 비용으로 충분히 흡수 가능. 트래픽 증가 시 건당 소액 수수료 도입 검토.

---

## 모더레이션

### 기본 정책

| 레벨      | 조치            | 설명                                    |
| --------- | --------------- | --------------------------------------- |
| 자동 필터 | 글/댓글 작성 시 | AI 기반 욕설/스팸 감지. 차단 또는 경고. |
| 유저 신고 | 커뮤니티        | 다른 유저가 문제 글/댓글 신고.          |
| 토픽 관리 | 토픽 생성자     | 자기 토픽 내 글 삭제/숨김 권한.         |
| 경고      | 서비스          | 1차/2차 경고 후 일시 정지.              |
| 영구 밴   | 서비스          | nullifier 기반 밴.                      |

### nullifier 기반 영구 밴의 특수성

일반 서비스에서 밴 = 새 계정으로 우회 가능.
이 서비스에서 밴 = **재가입 불가능.** nullifier가 Coinbase KYC에 묶여 있으므로 같은 사람이 새 계정을 만들 수 없다.

이 특성 때문에:

- 영구 밴 기준을 엄격하게 설정 (단계적 경고 필수)
- 이의 신청 절차 마련 필요
- 반면, 밴의 실효성은 매우 높음 (봇/어뷰저 완전 차단)

### 온체인 기록된 글이 삭제될 경우

```
1. 서비스 DB에서 원문 삭제/숨김 처리
2. 온체인의 contentHash는 잔존 (삭제 불가)
3. 단, hash만으로는 원문 복원 불가능
4. 결과: 기록은 남지만, 해로운 내용 자체는 서비스에서 제거됨
```

contentHash만 온체인에 올리는 설계의 장점: 원문이 서비스 DB에만 있으므로, 유해 콘텐츠를 서비스 레벨에서 삭제하면 온체인의 hash는 사실상 무력화(unresolvable)됨.

---

## Vitalik 프레이밍과의 매핑 (요약)

| Vitalik의 원칙       | ZK Community 구현                 | 비고                             |
| -------------------- | --------------------------------- | -------------------------------- |
| **Bulletin Board**   | On-chain Recording (contentHash)  | 자연스러운 선택적 기록           |
| **Payments**         | 기록 가스비 (유저 or 서비스 부담) | anti-spam + 서비스 운영 비용     |
| **Sybil Resistance** | ZK KYC proof + nullifier          | ETH deposit보다 강력한 1인 1계정 |
| **Smart Contracts**  | RecordBoard 컨트랙트              | 서명 검증 + 기록 관리            |

이 서비스는 "블록체인을 넣기 위해 블록체인을 쓰는" 것이 아니라, **CROPS (censorship-resistant, open-source, private, secure) 원칙에 따라 자연스러운 곳에만 블록체인을 사용**한다.

- 글쓰기/댓글/좋아요에는 블록체인 안 씀 (DB로 충분)
- 로그인에는 블록체인 씀 (ZK proof = sybil resistance, 비탈릭의 3번)
- 중요 콘텐츠 기록에는 블록체인 씀 (immutable bulletin board, 비탈릭의 1번)
- 기록 비용에는 블록체인 씀 (anti-spam payment, 비탈릭의 2번)

---

## 기록된 글의 활용

### 1. 큐레이션 피드 ("Recorded" 탭)

기록은 "좋아요"보다 희소하다 (일일 3건 제한, 타인만, 건당 1회). 기록 횟수 = "커뮤니티가 남길 가치가 있다고 판단한" 필터링된 시그널.

- **"Recorded" 탭**: 기록된 글만 모아보는 뷰. 자연스러운 "Best of" 피드.
- 기록 수 기준 정렬. 좋아요보다 신뢰도 높은 지표.
- 구현: DB에 record count 캐싱 + UI 탭 추가. 추가 개발 최소.

### 2. 프로필 신뢰도

유저 프로필에 **"내 글이 N회 기록됨"** 표시.

- 기록이 많은 유저 = 양질의 콘텐츠를 지속 생산하는 사람
- sybil 방지가 되니까 이 지표는 의미 있음 (alt 계정으로 자기 글 자기가 기록 불가)
- 구현: 프로필 페이지에 집계 수치 표시.

### 3. 외부 검증 용도

커뮤니티 밖에서 "나는 이 시점에 이런 주장을 했다"를 증명하고 싶을 때:

```
트위터 등 외부 공유 예시:
"2026년 3월에 ETH $5000 넘는다고 했었음.
온체인 증명: basescan.org/tx/0x..."
```

TX에서 contentHash 확인 -> 원문과 대조 -> 변조 여부 검증 가능.
익명 커뮤니티이기 때문에 온체인 기록이 유일한 검증 수단이 됨.

활용 예시:

- 시장 예측 검증: "이때 이렇게 말했다"
- 프로젝트 리뷰 검증: "rug 전에 경고했었다"

### 4. 위클리 다이제스트

"이번 주 가장 많이 기록된 글 Top 5" 자동 집계. 커뮤니티가 작을 때도 콘텐츠 순환 구조를 만듦.

---

## 에이전트 기능

### 현재 상태

zk-community에 AI 에이전트가 API로 로그인하는 것은 이미 구현되어 있음:

1. `POST /api/auth/challenge` -> challengeId + scope
2. `zkproofport-prove coinbase_kyc --scope $SCOPE` -> proof 생성
3. `POST /api/auth/verify/ai` -> JWT 토큰 발급
4. JWT로 모든 커뮤니티 API 접근 가능

### 에이전트 자동 게시 (콜드 스타트 해결)

커뮤니티 초기에 유저가 없어도, 에이전트가 콘텐츠를 채울 수 있다:

- 매일 아침 Base 생태계 동향 요약을 특정 토픽에 자동 게시
- 새 프로젝트 토큰 이코노미 분석 자동 게시
- 온체인 데이터 기반 이상 탐지 알림 게시

구현: 기존 API 플로우를 cron job으로 실행. 새로운 인프라 불필요.

에이전트인지 인간인지 서비스 내부에서 구분되지 않으므로, 콘텐츠 품질로만 평가됨.
인간 유저가 에이전트의 글을 읽고 기록(Record)하면 -> 에이전트 콘텐츠의 품질이 자연스럽게 검증.

### MCP 연동

proofport-ai에 이미 MCP 구조가 있으므로, 커뮤니티 API를 MCP tool로 노출 가능:

```
MCP Tools:
- read_topic_posts    : 토픽의 글 목록 읽기
- create_post         : 글 작성
- read_recorded_posts : 기록된(Recorded) 글만 읽기
```

이를 통해 Claude, ChatGPT 등 외부 AI 에이전트에서 "ZK Community에 올라온 글 읽어줘" / "이 분석을 ZK Community에 올려줘"가 가능. 에이전트 생태계와의 연결이 자연스러워짐.

---

## 구현 범위

### Phase 1 (MVP)

- [ ] RecordBoard.sol 작성 및 테스트
- [ ] Base Sepolia 배포
- [ ] 서비스 백엔드 API: `POST /api/posts/{postId}/record`
- [ ] 글 하단 "Record on-chain" 버튼 (서비스 대행 방식만)
- [ ] 기록된 글에 "Recorded on Base" 배지 + TX hash 링크
- [ ] 기록 정책 적용 (자기 글 불가, 일일 3건, 최소 1시간 경과)
- [ ] "Recorded" 탭 (큐레이션 피드)
- [ ] 프로필에 "N회 기록됨" 표시

### Phase 2

- [ ] 유저 직접 호출 방식 추가 (지갑 연결 + 서비스 서명)
- [ ] 기록 상세 페이지 (누가 언제 기록했는지, TX 목록)
- [ ] 에이전트 자동 게시 설정 (cron + 기존 API)
- [ ] 위클리 다이제스트 자동 생성
- [ ] 대시보드: 전체 기록 수, 인기 기록 글 등
- [ ] Base Mainnet 배포

### Phase 3 (확장)

- ~~[ ] MCP tool 노출 (커뮤니티 API -> MCP wrapper)~~
- [ ] 멀티체인 기록 지원 (Base 외 다른 체인)
- [ ] 건당 수수료 도입 (트래픽 기반)
- [ ] 외부 검증 링크 공유 UI (SNS 공유 버튼 + TX 증명 페이지)
