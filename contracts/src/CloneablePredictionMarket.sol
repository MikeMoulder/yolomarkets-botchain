// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SD59x18, sd } from "@prb/math/SD59x18.sol";

/// @title Binary LMSR prediction market settled in USDC.
/// @notice One winning share pays exactly 1 USDC (6-dec) at resolution.
///         The AMM's worst-case loss is `b * ln(2)`, bounded to the
///         `initialLiquidity` seed at construction.
contract CloneablePredictionMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant protocolFeeBps = 100; // 1.00%
    // Keep thin markets tradeable without allowing one order to move the
    // price all the way to 0 or 1. Values are SD59x18-scaled.
    int256 public constant MIN_PRICE_YES = 20_000_000_000_000_000; // 2%
    int256 public constant MAX_PRICE_YES = 980_000_000_000_000_000; // 98%

    enum Outcome {
        Unresolved,
        Yes,
        No,
        Cancelled
    }

    // ── Configuration ─────────────────────────────────────────────────────────
    IERC20 public usdc;
    address public admin;
    uint256 public deadline;
    uint256 public initialLiquidity; // 6-dec USDC seed
    SD59x18 public b; // liquidity parameter (18-dec)
    // Starts at 1 and increments whenever an empty round is rolled over.
    uint256 public roundId;
    bool private initialized;

    string public question;
    string public category;
    string public resolutionCriteria;

    // ── State ─────────────────────────────────────────────────────────────────
    SD59x18 public qYes; // cumulative YES shares (18-dec)
    SD59x18 public qNo; // cumulative NO shares (18-dec)
    Outcome public outcome;
    bool public resolved;
    uint256 public accruedFees; // 6-dec USDC
    uint256 public tradeCount;

    mapping(address => uint256) public sharesYes; // 6-dec
    mapping(address => uint256) public sharesNo; // 6-dec
    uint256 public totalSharesYes; // 6-dec
    uint256 public totalSharesNo; // 6-dec

    // Net USDC each trader has at risk in the AMM (6-dec): increased by the
    // full cost of buys (incl. fee), decreased by sell proceeds (clamped at 0
    // so a trader who sold at a profit keeps it and is owed nothing). On a
    // Cancelled resolution this is exactly what each trader is refunded, which
    // is why cancellation can no longer be used to seize user principal.
    mapping(address => uint256) public costBasis; // 6-dec
    uint256 public totalCostBasis; // 6-dec, Σ costBasis

    // ── Events ────────────────────────────────────────────────────────────────
    event Bought(
        address indexed who,
        Outcome indexed outcome,
        uint256 shares,
        uint256 cost,
        uint256 fee,
        int256 newPriceYesRaw // SD59x18-unwrapped, in [0, 1e18]
    );
    event Sold(
        address indexed who,
        Outcome indexed outcome,
        uint256 shares,
        uint256 received,
        uint256 fee,
        int256 newPriceYesRaw
    );
    event Resolved(Outcome outcome);
    event RolledOver(
        uint256 indexed previousRoundId,
        uint256 indexed newRoundId,
        uint256 newDeadline,
        string question
    );
    event Claimed(address indexed who, uint256 amount);
    event Refunded(address indexed who, uint256 amount);
    event TreasuryWithdrawn(address indexed to, uint256 amount);

    // ── Errors ────────────────────────────────────────────────────────────────
    error AlreadyResolved();
    error NotResolved();
    error PastDeadline();
    error BeforeDeadline();
    error BadOutcome();
    error ZeroShares();
    error InsufficientShares();
    error Slippage();
    error NotAdmin();
    error NothingToClaim();
    error NothingToRefund();
    error BadRecipient();
    error InsufficientReserves();
    error MarketCancelled();
    error NotCancelled();
    error HasTradingActivity();
    error PriceBandExceeded(int256 priceYesRaw);
    error AlreadyInitialized();

    /// @dev The implementation is permanently unusable. Clones have their own
    /// storage and start with `initialized == false`.
    constructor() {
        initialized = true;
    }

    function initialize(
        IERC20 _usdc,
        address _admin,
        uint256 _deadline,
        uint256 _initialLiquidity, // 6-dec
        string memory _question,
        string memory _category,
        string memory _resolutionCriteria
    ) external {
        if (initialized) revert AlreadyInitialized();
        require(_deadline > block.timestamp, "deadline in past");
        require(_initialLiquidity > 0, "no liquidity");

        initialized = true;
        usdc = _usdc;
        admin = _admin;
        deadline = _deadline;
        initialLiquidity = _initialLiquidity;
        roundId = 1;
        question = _question;
        category = _category;
        resolutionCriteria = _resolutionCriteria;

        // b = initialLiquidity / ln(2)   (18-dec internal scale)
        // ln(2) constant in SD59x18 = 693_147_180_559_945_309
        SD59x18 liq = sd(int256(_initialLiquidity * 1e12));
        SD59x18 ln2 = sd(693_147_180_559_945_309);
        b = liq.div(ln2);

        _usdc.safeTransferFrom(msg.sender, address(this), _initialLiquidity);
    }

    // ── Trading ───────────────────────────────────────────────────────────────

    /// @notice Buy `_shares` (6-dec) of `_outcome`, paying at most `_maxCost` USDC.
    /// @return cost USDC actually charged (6-dec, rounded UP)
    function buy(Outcome _outcome, uint256 _shares, uint256 _maxCost)
        external
        nonReentrant
        returns (uint256 cost)
    {
        if (resolved) revert AlreadyResolved();
        if (block.timestamp >= deadline) revert PastDeadline();
        if (_outcome != Outcome.Yes && _outcome != Outcome.No) {
            revert BadOutcome();
        }
        if (_shares == 0) revert ZeroShares();

        (SD59x18 newQYes, SD59x18 newQNo) = _addShares(qYes, qNo, _outcome, _shares);
        _enforcePriceBand(newQYes, newQNo);
        uint256 baseCost = _diffCostUp(qYes, qNo, newQYes, newQNo);
        uint256 fee = _feeOn(baseCost);
        cost = baseCost + fee;
        if (cost > _maxCost) revert Slippage();

        qYes = newQYes;
        qNo = newQNo;
        if (_outcome == Outcome.Yes) {
            sharesYes[msg.sender] += _shares;
            totalSharesYes += _shares;
        } else {
            sharesNo[msg.sender] += _shares;
            totalSharesNo += _shares;
        }

        costBasis[msg.sender] += cost;
        totalCostBasis += cost;
        accruedFees += fee;
        tradeCount += 1;
        usdc.safeTransferFrom(msg.sender, address(this), cost);
        _assertSolvent();
        emit Bought(msg.sender, _outcome, _shares, cost, fee, _priceYesRaw(newQYes, newQNo));
    }

    /// @notice Sell `_shares` of `_outcome`, receiving at least `_minReceived` USDC.
    /// @return received USDC paid back (6-dec, rounded DOWN)
    function sell(Outcome _outcome, uint256 _shares, uint256 _minReceived)
        external
        nonReentrant
        returns (uint256 received)
    {
        if (resolved) revert AlreadyResolved();
        if (block.timestamp >= deadline) revert PastDeadline();
        if (_outcome != Outcome.Yes && _outcome != Outcome.No) {
            revert BadOutcome();
        }
        if (_shares == 0) revert ZeroShares();

        if (_outcome == Outcome.Yes) {
            if (sharesYes[msg.sender] < _shares) revert InsufficientShares();
        } else {
            if (sharesNo[msg.sender] < _shares) revert InsufficientShares();
        }

        (SD59x18 newQYes, SD59x18 newQNo) = _subShares(qYes, qNo, _outcome, _shares);
        _enforcePriceBand(newQYes, newQNo);
        uint256 gross = _diffCostDown(newQYes, newQNo, qYes, qNo);
        uint256 fee = _feeOn(gross);
        received = gross - fee;
        if (received < _minReceived) revert Slippage();

        qYes = newQYes;
        qNo = newQNo;
        if (_outcome == Outcome.Yes) {
            sharesYes[msg.sender] -= _shares;
            totalSharesYes -= _shares;
        } else {
            sharesNo[msg.sender] -= _shares;
            totalSharesNo -= _shares;
        }

        // Reduce the seller's at-risk basis by what they took out, clamped at
        // zero. A sale above cost leaves basis at 0 — the realized profit is
        // theirs and is not refundable on a later cancellation.
        uint256 cb = costBasis[msg.sender];
        uint256 dec = received < cb ? received : cb;
        costBasis[msg.sender] = cb - dec;
        totalCostBasis -= dec;

        accruedFees += fee;
        tradeCount += 1;
        usdc.safeTransfer(msg.sender, received);
        _assertSolvent();
        emit Sold(msg.sender, _outcome, _shares, received, fee, _priceYesRaw(newQYes, newQNo));
    }

    // ── Resolution ────────────────────────────────────────────────────────────

    function resolve(Outcome _outcome) external {
        if (msg.sender != admin) revert NotAdmin();
        if (resolved) revert AlreadyResolved();
        if (block.timestamp < deadline) revert BeforeDeadline();
        if (_outcome != Outcome.Yes && _outcome != Outcome.No && _outcome != Outcome.Cancelled) {
            revert BadOutcome();
        }

        resolved = true;
        outcome = _outcome;
        emit Resolved(_outcome);
    }

    /// @notice Reuse an expired market for a new round when nobody traded.
    ///         The seed remains in this contract, avoiding cancellation,
    ///         withdrawal, and redeployment gas. A round with any activity is
    ///         never overwritten.
    function rollover(
        uint256 _newDeadline,
        string calldata _question,
        string calldata _category,
        string calldata _resolutionCriteria
    ) external {
        if (msg.sender != admin) revert NotAdmin();
        if (resolved) revert AlreadyResolved();
        if (block.timestamp < deadline) revert BeforeDeadline();
        if (tradeCount != 0 || totalSharesYes != 0 || totalSharesNo != 0 || totalCostBasis != 0) {
            revert HasTradingActivity();
        }
        require(_newDeadline > block.timestamp, "deadline in past");

        uint256 previousRoundId = roundId;
        deadline = _newDeadline;
        question = _question;
        category = _category;
        resolutionCriteria = _resolutionCriteria;
        roundId = previousRoundId + 1;

        emit RolledOver(previousRoundId, roundId, _newDeadline, _question);
    }

    /// @notice After resolution, redeem winning shares 1:1 for USDC.
    function claim() external nonReentrant returns (uint256 amount) {
        if (!resolved) revert NotResolved();
        if (outcome == Outcome.Cancelled) revert MarketCancelled();

        if (outcome == Outcome.Yes) {
            amount = sharesYes[msg.sender];
            sharesYes[msg.sender] = 0;
            totalSharesYes -= amount;
        } else {
            amount = sharesNo[msg.sender];
            sharesNo[msg.sender] = 0;
            totalSharesNo -= amount;
        }
        if (amount == 0) revert NothingToClaim();

        usdc.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice If the market was Cancelled, redeem your net at-risk USDC
    ///         (cost basis) 1:1. This is the refund path that makes
    ///         cancellation non-confiscatory — the admin's treasury withdrawal
    ///         is fenced off from outstanding refunds via `reserveRequired()`.
    function claimRefund() external nonReentrant returns (uint256 amount) {
        if (!resolved) revert NotResolved();
        if (outcome != Outcome.Cancelled) revert NotCancelled();

        amount = costBasis[msg.sender];
        if (amount == 0) revert NothingToRefund();
        costBasis[msg.sender] = 0;
        totalCostBasis -= amount;

        usdc.safeTransfer(msg.sender, amount);
        emit Refunded(msg.sender, amount);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @return SD59x18-scaled probability of YES, range [0, 1e18]
    function priceYes() external view returns (int256) {
        return _priceYesRaw(qYes, qNo);
    }

    /// @notice Preview buy cost (6-dec USDC, rounded UP).
    function previewBuy(Outcome _outcome, uint256 _shares) external view returns (uint256 cost) {
        if (_outcome != Outcome.Yes && _outcome != Outcome.No) return 0;
        if (_shares == 0) return 0;
        (SD59x18 newQYes, SD59x18 newQNo) = _addShares(qYes, qNo, _outcome, _shares);
        uint256 baseCost = _diffCostUp(qYes, qNo, newQYes, newQNo);
        cost = baseCost + _feeOn(baseCost);
    }

    /// @notice Preview sell proceeds (6-dec USDC, rounded DOWN).
    function previewSell(Outcome _outcome, uint256 _shares)
        external
        view
        returns (uint256 received)
    {
        if (_outcome != Outcome.Yes && _outcome != Outcome.No) return 0;
        if (_shares == 0) return 0;
        (SD59x18 newQYes, SD59x18 newQNo) = _subShares(qYes, qNo, _outcome, _shares);
        uint256 gross = _diffCostDown(newQYes, newQNo, qYes, qNo);
        received = gross - _feeOn(gross);
    }

    function totalLiquidity() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function reserveRequired() public view returns (uint256) {
        if (!resolved) {
            return totalSharesYes > totalSharesNo ? totalSharesYes : totalSharesNo;
        }
        if (outcome == Outcome.Yes) return totalSharesYes;
        if (outcome == Outcome.No) return totalSharesNo;
        // Cancelled: outstanding refunds are owed to traders. The treasury can
        // only ever withdraw the surplus above this (the seed + accrued fees),
        // never user principal.
        return totalCostBasis;
    }

    function treasuryWithdrawable() public view returns (uint256) {
        uint256 bal = usdc.balanceOf(address(this));
        uint256 reserve = reserveRequired();
        if (bal <= reserve) return 0;
        return bal - reserve;
    }

    function withdrawTreasury(address to, uint256 amount) external nonReentrant {
        if (msg.sender != admin) revert NotAdmin();
        if (!resolved) revert NotResolved();
        if (to == address(0)) revert BadRecipient();
        if (amount > treasuryWithdrawable()) revert InsufficientReserves();

        usdc.safeTransfer(to, amount);
        emit TreasuryWithdrawn(to, amount);
    }

    function _assertSolvent() internal view {
        if (usdc.balanceOf(address(this)) < reserveRequired()) {
            revert InsufficientReserves();
        }
    }

    function _enforcePriceBand(SD59x18 _qYes, SD59x18 _qNo) internal view {
        int256 p = _priceYesRaw(_qYes, _qNo);
        if (p < MIN_PRICE_YES || p > MAX_PRICE_YES) {
            revert PriceBandExceeded(p);
        }
    }

    // ── Internal LMSR ─────────────────────────────────────────────────────────

    function _addShares(SD59x18 _qYes, SD59x18 _qNo, Outcome _outcome, uint256 _shares)
        internal
        pure
        returns (SD59x18 nYes, SD59x18 nNo)
    {
        SD59x18 dShares = sd(int256(_shares * 1e12));
        if (_outcome == Outcome.Yes) {
            nYes = _qYes.add(dShares);
            nNo = _qNo;
        } else {
            nYes = _qYes;
            nNo = _qNo.add(dShares);
        }
    }

    function _subShares(SD59x18 _qYes, SD59x18 _qNo, Outcome _outcome, uint256 _shares)
        internal
        pure
        returns (SD59x18 nYes, SD59x18 nNo)
    {
        SD59x18 dShares = sd(int256(_shares * 1e12));
        if (_outcome == Outcome.Yes) {
            nYes = _qYes.sub(dShares);
            nNo = _qNo;
        } else {
            nYes = _qYes;
            nNo = _qNo.sub(dShares);
        }
    }

    /// @dev cost(newQ) - cost(oldQ), 6-dec USDC rounded UP. Reverts on non-positive.
    function _diffCostUp(SD59x18 _qYesOld, SD59x18 _qNoOld, SD59x18 _qYesNew, SD59x18 _qNoNew)
        internal
        view
        returns (uint256)
    {
        int256 oldC = SD59x18.unwrap(_C(_qYesOld, _qNoOld));
        int256 newC = SD59x18.unwrap(_C(_qYesNew, _qNoNew));
        int256 diff = newC - oldC;
        require(diff > 0, "non-positive cost");
        return (uint256(diff) + 1e12 - 1) / 1e12;
    }

    /// @dev cost(oldQ) - cost(newQ), 6-dec USDC rounded DOWN. Reverts on non-positive.
    function _diffCostDown(SD59x18 _qYesNew, SD59x18 _qNoNew, SD59x18 _qYesOld, SD59x18 _qNoOld)
        internal
        view
        returns (uint256)
    {
        int256 oldC = SD59x18.unwrap(_C(_qYesOld, _qNoOld));
        int256 newC = SD59x18.unwrap(_C(_qYesNew, _qNoNew));
        int256 diff = oldC - newC;
        require(diff > 0, "non-positive proceeds");
        return uint256(diff) / 1e12;
    }

    /// @dev LMSR cost function: C = b · ln(exp(qY/b) + exp(qN/b))
    function _C(SD59x18 _qYes, SD59x18 _qNo) internal view returns (SD59x18) {
        SD59x18 eY = _qYes.div(b).exp();
        SD59x18 eN = _qNo.div(b).exp();
        return eY.add(eN).ln().mul(b);
    }

    /// @dev p(YES) = exp(qY/b) / (exp(qY/b) + exp(qN/b)). Returns SD59x18-unwrapped.
    function _priceYesRaw(SD59x18 _qYes, SD59x18 _qNo) internal view returns (int256) {
        SD59x18 eY = _qYes.div(b).exp();
        SD59x18 eN = _qNo.div(b).exp();
        return SD59x18.unwrap(eY.div(eY.add(eN)));
    }

    function _feeOn(uint256 amount) internal pure returns (uint256) {
        return (amount * protocolFeeBps) / 10_000;
    }
}
