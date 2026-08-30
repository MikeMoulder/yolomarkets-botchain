// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {PredictionMarket} from "./PredictionMarket.sol";

/// @title Factory + role-separated admin for binary prediction markets.
/// @notice Two roles, deliberately split so the hot key that settles markets
///         can never touch funds (audit H-1):
///           · admin    — creates/seeds markets, withdraws treasury, manages
///                        roles. Intended to be a multisig / cold key.
///           · resolver — settles markets after their deadline. Intended to be
///                        an operational hot key (the resolution keeper). A
///                        compromised resolver can mis-settle a market but
///                        CANNOT move USDC or change roles.
///         Admin transfer is two-step (transfer/accept) so a fat-fingered
///         address can't brick the protocol.
contract MarketFactory {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public admin;
    address public pendingAdmin;
    address public resolver;

    address[] public markets;
    mapping(address => bool) public isMarket;
    mapping(address => uint256) public marketIndex; // 1-based; 0 = not present

    event MarketCreated(
        address indexed market,
        string question,
        string category,
        uint256 deadline,
        uint256 initialLiquidity
    );
    event MarketResolved(
        address indexed market,
        PredictionMarket.Outcome outcome
    );
    event MarketTreasuryWithdrawn(
        address indexed market,
        address indexed to,
        uint256 amount
    );
    event AdminTransferStarted(
        address indexed previous,
        address indexed pending
    );
    event AdminChanged(address indexed previous, address indexed current);
    event ResolverChanged(address indexed previous, address indexed current);

    error NotAdmin();
    error NotResolver();
    error UnknownMarket();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyResolver() {
        if (msg.sender != resolver) revert NotResolver();
        _;
    }

    constructor(IERC20 _usdc, address _admin, address _resolver) {
        require(_admin != address(0) && _resolver != address(0), "zero role");
        usdc = _usdc;
        admin = _admin;
        resolver = _resolver;
        emit AdminChanged(address(0), _admin);
        emit ResolverChanged(address(0), _resolver);
    }

    /// @notice Deploy a new market. The factory is the market's admin (so
    ///         resolution authority lives here). Pulls `initialLiquidity` USDC
    ///         from the calling admin → factory → market in one tx.
    function createMarket(
        string calldata question,
        string calldata category,
        string calldata resolutionCriteria,
        uint256 deadline,
        uint256 initialLiquidity
    ) external onlyAdmin returns (address market) {
        // Pull seed USDC from admin into the factory itself.
        usdc.safeTransferFrom(msg.sender, address(this), initialLiquidity);

        bytes32 salt = keccak256(abi.encodePacked(question, deadline));
        bytes memory bytecode = abi.encodePacked(
            type(PredictionMarket).creationCode,
            abi.encode(
                usdc,
                address(this), // factory is the market's admin
                deadline,
                initialLiquidity,
                question,
                category,
                resolutionCriteria
            )
        );
        address predicted = Create2.computeAddress(salt, keccak256(bytecode));

        // Pre-approve the about-to-exist market for the seed amount, then deploy.
        usdc.forceApprove(predicted, initialLiquidity);

        market = Create2.deploy(0, salt, bytecode);
        require(market == predicted, "CREATE2 mismatch");

        markets.push(market);
        isMarket[market] = true;
        marketIndex[market] = markets.length; // 1-based

        emit MarketCreated(
            market,
            question,
            category,
            deadline,
            initialLiquidity
        );
    }

    /// @notice Resolve a market after its deadline. Only callable by the
    ///         resolver role (not admin) — settlement authority is separated
    ///         from fund-moving authority.
    function resolveMarket(
        address market,
        PredictionMarket.Outcome outcome
    ) external onlyResolver {
        if (!isMarket[market]) revert UnknownMarket();
        PredictionMarket(market).resolve(outcome);
        emit MarketResolved(market, outcome);
    }

    /// @notice Reuse an expired fast market that had no trading activity.
    ///         The market contract enforces the no-trade invariant and keeps
    ///         its existing USDC seed in place.
    function rolloverMarket(
        address market,
        string calldata question,
        string calldata category,
        string calldata resolutionCriteria,
        uint256 deadline
    ) external onlyResolver {
        if (!isMarket[market]) revert UnknownMarket();
        PredictionMarket(market).rollover(
            deadline,
            question,
            category,
            resolutionCriteria
        );
    }

    /// @notice Withdraw accrued fees / surplus from a market to `to`.
    function withdrawMarketTreasury(
        address market,
        address to,
        uint256 amount
    ) external onlyAdmin {
        if (!isMarket[market]) revert UnknownMarket();
        PredictionMarket(market).withdrawTreasury(to, amount);
        emit MarketTreasuryWithdrawn(market, to, amount);
    }

    /// @notice Begin a two-step admin handover. `newAdmin` must then call
    ///         `acceptAdmin()` to take the role — this prevents transferring to
    ///         an address that can't act (typo / wrong key / non-EOA).
    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "zero admin");
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    /// @notice Complete the admin handover. Callable only by the pending admin.
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        emit AdminChanged(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    /// @notice Rotate the resolver (operational settlement key). Admin-only.
    function setResolver(address newResolver) external onlyAdmin {
        require(newResolver != address(0), "zero resolver");
        emit ResolverChanged(resolver, newResolver);
        resolver = newResolver;
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function allMarkets() external view returns (address[] memory) {
        return markets;
    }

    /// @notice Predict a market's CREATE2 address before deployment.
    function predictMarket(
        string calldata question,
        string calldata category,
        string calldata resolutionCriteria,
        uint256 deadline,
        uint256 initialLiquidity
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(question, deadline));
        bytes memory bytecode = abi.encodePacked(
            type(PredictionMarket).creationCode,
            abi.encode(
                usdc,
                address(this),
                deadline,
                initialLiquidity,
                question,
                category,
                resolutionCriteria
            )
        );
        return Create2.computeAddress(salt, keccak256(bytecode));
    }
}
