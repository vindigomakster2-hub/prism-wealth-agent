// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, IPriceOracle, ICreditRegistry} from "./Interfaces.sol";

/// @title HybridLendingPool
/// @notice Borrow USDC against WETH. Borrowers with an active Proof-of-Wealth attestation get:
///         1) a lower rate by tier, and
///         2) extra borrowing power from their pledged off-chain credit line,
///            capped at `creditCapBps` of on-chain collateral, so a loan is never fully unsecured.
///         All funds always flow to/from msg.sender (no receiver params), which keeps agent wallets safe.
contract HybridLendingPool {
    uint256 public constant BPS = 10_000;
    uint256 public constant YEAR = 365 days;

    IERC20 public immutable usdc;
    IERC20 public immutable weth;
    IPriceOracle public immutable oracle;
    ICreditRegistry public immutable registry;

    uint256 public baseLtvBps = 7_000;
    uint256 public liqThresholdBps = 8_000;
    uint256 public liqBonusBps = 500;
    uint256 public closeFactorBps = 5_000;
    uint256 public creditCapBps = 5_000;
    uint16[4] public tierRateBps = [uint16(900), 750, 600, 450];

    struct Position {
        uint256 collateral;
        uint256 debt;
        uint64 lastAccrual;
        uint16 rateBps;
    }

    struct PositionView {
        uint256 collateral;
        uint256 collateralUsd6;
        uint256 debt;
        uint256 creditLineUsd6;
        uint256 borrowingPowerUsd6;
        uint256 liquidationValueUsd6;
        uint256 healthFactor;
        uint256 rateBps;
        uint8 tier;
        bool pledged;
    }

    mapping(address => Position) internal _positions;
    mapping(address => uint256) public liquidationPenaltyUsd6;
    mapping(address => uint256) public liquidationCount;

    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount, uint256 rateBps);
    event Repaid(address indexed user, uint256 amount);
    event CreditPledged(address indexed user);
    event CreditReleased(address indexed user);
    event Liquidated(address indexed user, address indexed liquidator, uint256 repaid, uint256 seized, uint256 penaltyUsd6);

    constructor(address _usdc, address _weth, address _oracle, address _registry) {
        usdc = IERC20(_usdc);
        weth = IERC20(_weth);
        oracle = IPriceOracle(_oracle);
        registry = ICreditRegistry(_registry);
    }

    // ---------------------------------------------------------------- views

    function tierOf(address user) public view returns (uint8 tier) {
        (tier,,) = registry.activeCredit(user);
    }

    function currentRateBps(address user) public view returns (uint256) {
        return tierRateBps[tierOf(user)];
    }

    function debtOf(address user) public view returns (uint256) {
        Position storage p = _positions[user];
        if (p.debt == 0) return 0;
        return p.debt + (p.debt * p.rateBps * (block.timestamp - p.lastAccrual)) / (BPS * YEAR);
    }

    function collateralUsd6(address user) public view returns (uint256) {
        uint256 c = _positions[user].collateral;
        return c == 0 ? 0 : oracle.valueUsd6(address(weth), c);
    }

    /// @notice Usable off-chain credit: only if pledged here, attestation active, capped by on-chain collateral.
    function creditLineUsd6(address user) public view returns (uint256) {
        if (registry.pledgedTo(user) != address(this)) return 0;
        (, uint256 line,) = registry.activeCredit(user);
        uint256 cap = (collateralUsd6(user) * creditCapBps) / BPS;
        return line < cap ? line : cap;
    }

    function borrowingPowerUsd6(address user) public view returns (uint256) {
        return (collateralUsd6(user) * baseLtvBps) / BPS + creditLineUsd6(user);
    }

    function liquidationValueUsd6(address user) public view returns (uint256) {
        return (collateralUsd6(user) * liqThresholdBps) / BPS + creditLineUsd6(user);
    }

    /// @return hf health factor scaled by 1e18 (type(uint256).max when there is no debt)
    function healthFactor(address user) public view returns (uint256) {
        uint256 d = debtOf(user);
        if (d == 0) return type(uint256).max;
        return (liquidationValueUsd6(user) * 1e18) / d;
    }

    function positionOf(address user) external view returns (PositionView memory v) {
        v.collateral = _positions[user].collateral;
        v.collateralUsd6 = collateralUsd6(user);
        v.debt = debtOf(user);
        v.creditLineUsd6 = creditLineUsd6(user);
        v.borrowingPowerUsd6 = borrowingPowerUsd6(user);
        v.liquidationValueUsd6 = liquidationValueUsd6(user);
        v.healthFactor = healthFactor(user);
        v.rateBps = currentRateBps(user);
        v.tier = tierOf(user);
        v.pledged = registry.pledgedTo(user) == address(this);
    }

    // -------------------------------------------------------------- actions

    function depositCollateral(uint256 amount) external {
        require(amount > 0, "zero amount");
        _accrue(msg.sender);
        require(weth.transferFrom(msg.sender, address(this), amount), "transfer failed");
        _positions[msg.sender].collateral += amount;
        emit CollateralDeposited(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount) external {
        _accrue(msg.sender);
        Position storage p = _positions[msg.sender];
        require(p.collateral >= amount, "not enough collateral");
        p.collateral -= amount;
        require(p.debt <= borrowingPowerUsd6(msg.sender), "would exceed borrowing power");
        require(weth.transfer(msg.sender, amount), "transfer failed");
        emit CollateralWithdrawn(msg.sender, amount);
    }

    function borrow(uint256 amount) external {
        require(amount > 0, "zero amount");
        _accrue(msg.sender);
        Position storage p = _positions[msg.sender];
        p.debt += amount;
        require(p.debt <= borrowingPowerUsd6(msg.sender), "exceeds borrowing power");
        require(usdc.transfer(msg.sender, amount), "pool liquidity");
        emit Borrowed(msg.sender, amount, p.rateBps);
    }

    function repay(uint256 amount) external returns (uint256 repaid) {
        _accrue(msg.sender);
        Position storage p = _positions[msg.sender];
        repaid = amount > p.debt ? p.debt : amount;
        require(repaid > 0, "nothing to repay");
        require(usdc.transferFrom(msg.sender, address(this), repaid), "transfer failed");
        p.debt -= repaid;
        emit Repaid(msg.sender, repaid);
    }

    function pledgeCredit() external {
        _accrue(msg.sender);
        registry.pledge(msg.sender);
        emit CreditPledged(msg.sender);
    }

    function releaseCredit() external {
        _accrue(msg.sender);
        registry.release(msg.sender);
        require(_positions[msg.sender].debt <= borrowingPowerUsd6(msg.sender), "credit line in use");
        emit CreditReleased(msg.sender);
    }

    /// @notice Anyone may repay up to closeFactor of an unhealthy position and seize collateral at a bonus.
    ///         Note: the off-chain credit portion cannot be seized on-chain; in production a default on it
    ///         is enforced through the legal pledge behind the attestation.
    function liquidate(address user, uint256 repayAmount) external returns (uint256 seized) {
        _accrue(user);
        require(healthFactor(user) < 1e18, "position healthy");
        Position storage p = _positions[user];
        uint256 maxRepay = (p.debt * closeFactorBps) / BPS;
        if (repayAmount > maxRepay) repayAmount = maxRepay;
        require(repayAmount > 0, "nothing to repay");

        seized = oracle.amountForUsd6(address(weth), (repayAmount * (BPS + liqBonusBps)) / BPS);
        if (seized > p.collateral) seized = p.collateral;
        uint256 seizedUsd6 = oracle.valueUsd6(address(weth), seized);

        require(usdc.transferFrom(msg.sender, address(this), repayAmount), "transfer failed");
        p.debt -= repayAmount;
        p.collateral -= seized;
        uint256 penalty = seizedUsd6 > repayAmount ? seizedUsd6 - repayAmount : 0;
        liquidationPenaltyUsd6[user] += penalty;
        liquidationCount[user] += 1;
        require(weth.transfer(msg.sender, seized), "transfer failed");
        emit Liquidated(user, msg.sender, repayAmount, seized, penalty);
    }

    function _accrue(address user) internal {
        Position storage p = _positions[user];
        if (p.debt > 0) {
            p.debt += (p.debt * p.rateBps * (block.timestamp - p.lastAccrual)) / (BPS * YEAR);
        }
        p.lastAccrual = uint64(block.timestamp);
        p.rateBps = tierRateBps[tierOf(user)];
    }
}
