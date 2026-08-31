// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { CloneablePredictionMarket } from "./CloneablePredictionMarket.sol";

/// @title Experimental minimal-proxy factory for YOLO Markets
/// @notice Testnet-only comparison path. It deploys one market implementation
///         and creates cheap ERC-1167 clones initialized with per-market data.
///         The production MarketFactory remains unchanged.
contract CloneableMarketFactory {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public admin;
    address public pendingAdmin;
    address public resolver;
    address public immutable implementation;

    address[] public markets;
    mapping(address => bool) public isMarket;
    mapping(address => uint256) public marketIndex;

    event MarketCreated(
        address indexed market,
        string question,
        string category,
        uint256 deadline,
        uint256 initialLiquidity
    );
    event MarketResolved(address indexed market, CloneablePredictionMarket.Outcome outcome);
    event MarketTreasuryWithdrawn(address indexed market, address indexed to, uint256 amount);
    event AdminTransferStarted(address indexed previous, address indexed pending);
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
        implementation = address(new CloneablePredictionMarket());
        emit AdminChanged(address(0), _admin);
        emit ResolverChanged(address(0), _resolver);
    }

    function createMarket(
        string calldata question,
        string calldata category,
        string calldata resolutionCriteria,
        uint256 deadline,
        uint256 initialLiquidity
    ) external onlyAdmin returns (address market) {
        usdc.safeTransferFrom(msg.sender, address(this), initialLiquidity);

        bytes32 salt = keccak256(abi.encodePacked(question, deadline));
        market = Clones.cloneDeterministic(implementation, salt);

        usdc.forceApprove(market, initialLiquidity);
        CloneablePredictionMarket(market)
            .initialize(
                usdc,
                address(this),
                deadline,
                initialLiquidity,
                question,
                category,
                resolutionCriteria
            );

        markets.push(market);
        isMarket[market] = true;
        marketIndex[market] = markets.length;

        emit MarketCreated(market, question, category, deadline, initialLiquidity);
    }

    function resolveMarket(address market, CloneablePredictionMarket.Outcome outcome)
        external
        onlyResolver
    {
        if (!isMarket[market]) revert UnknownMarket();
        CloneablePredictionMarket(market).resolve(outcome);
        emit MarketResolved(market, outcome);
    }

    function rolloverMarket(
        address market,
        string calldata question,
        string calldata category,
        string calldata resolutionCriteria,
        uint256 deadline
    ) external onlyResolver {
        if (!isMarket[market]) revert UnknownMarket();
        CloneablePredictionMarket(market).rollover(deadline, question, category, resolutionCriteria);
    }

    function withdrawMarketTreasury(address market, address to, uint256 amount) external onlyAdmin {
        if (!isMarket[market]) revert UnknownMarket();
        CloneablePredictionMarket(market).withdrawTreasury(to, amount);
        emit MarketTreasuryWithdrawn(market, to, amount);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "zero admin");
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        emit AdminChanged(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    function setResolver(address newResolver) external onlyAdmin {
        require(newResolver != address(0), "zero resolver");
        emit ResolverChanged(resolver, newResolver);
        resolver = newResolver;
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function allMarkets() external view returns (address[] memory) {
        return markets;
    }

    function predictMarket(string calldata question, uint256 deadline)
        external
        view
        returns (address)
    {
        bytes32 salt = keccak256(abi.encodePacked(question, deadline));
        return Clones.predictDeterministicAddress(implementation, salt, address(this));
    }

    /// @notice Compatibility overload matching MarketFactory.predictMarket.
    ///         Clone addresses depend only on question and deadline; the other
    ///         arguments are accepted so existing tooling can switch factories.
    function predictMarket(
        string calldata question,
        string calldata,
        string calldata,
        uint256 deadline,
        uint256
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(question, deadline));
        return Clones.predictDeterministicAddress(implementation, salt, address(this));
    }
}
