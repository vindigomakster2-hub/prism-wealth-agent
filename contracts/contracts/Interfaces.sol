// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IPriceOracle {
    function valueUsd6(address token, uint256 amount) external view returns (uint256);
    function amountForUsd6(address token, uint256 usd6) external view returns (uint256);
}

interface ICreditRegistry {
    function activeCredit(address subject) external view returns (uint8 tier, uint256 creditLineUsd6, uint64 expiresAt);
    function pledgedTo(address subject) external view returns (address);
    function pledge(address subject) external;
    function release(address subject) external;
}

interface IHealthSource {
    function healthFactor(address user) external view returns (uint256);
}

interface ILiquidationSource {
    function liquidationPenaltyUsd6(address user) external view returns (uint256);
}
