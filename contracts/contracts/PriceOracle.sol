// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./Interfaces.sol";

/// @notice Admin-set price feed (8 decimals, Chainlink-style). On mainnet this is a Chainlink/Pyth adapter;
///         locally it lets the demo crash ETH on demand.
contract PriceOracle {
    address public owner;
    mapping(address => uint256) public priceE8;

    event PriceUpdated(address indexed token, uint256 priceE8);

    constructor() {
        owner = msg.sender;
    }

    function setPrice(address token, uint256 newPriceE8) external {
        require(msg.sender == owner, "only owner");
        require(newPriceE8 > 0, "zero price");
        priceE8[token] = newPriceE8;
        emit PriceUpdated(token, newPriceE8);
    }

    /// @return usd6 USD value with 6 decimals
    function valueUsd6(address token, uint256 amount) public view returns (uint256) {
        uint256 p = priceE8[token];
        require(p > 0, "no price");
        return (amount * p) / (10 ** IERC20(token).decimals()) / 100;
    }

    function amountForUsd6(address token, uint256 usd6) public view returns (uint256) {
        uint256 p = priceE8[token];
        require(p > 0, "no price");
        return (usd6 * 100 * (10 ** IERC20(token).decimals())) / p;
    }
}
