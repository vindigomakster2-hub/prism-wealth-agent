// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle, IHealthSource} from "./Interfaces.sol";

/// @title AgentWallet
/// @notice Smart account holding the user's on-chain assets. Two keys:
///         - owner: unrestricted (user's device / passkey); can pause or rotate the agent at any time.
///         - agent: a scoped session key used by the AI. Every agent call is checked ON-CHAIN:
///             * (target, selector) must be allow-listed,
///             * ERC-20 transfer/approve counterparties must be allow-listed,
///             * transfers count against a rolling 24h USD limit,
///             * after a batch, loan health must stay above a floor or not get worse,
///             * the key can be paused and expires.
///         Even a fully compromised agent cannot send funds to an unknown address.
contract AgentWallet {
    struct Call {
        address target;
        bytes data;
    }

    bytes4 internal constant TRANSFER = 0xa9059cbb;
    bytes4 internal constant APPROVE = 0x095ea7b3;

    address public owner;
    address public agent;
    bool public agentPaused;
    uint64 public agentExpiry;

    IPriceOracle public oracle;
    IHealthSource public healthSource;
    uint256 public minHealthFactor;

    uint256 public dailyLimitUsd6;
    uint256 public spentTodayUsd6;
    uint64 public windowStart;

    mapping(address => mapping(bytes4 => bool)) public allowedCall;
    mapping(address => bool) public allowedCounterparty;

    event Executed(address indexed caller, address indexed target, bytes4 selector);
    event AgentUpdated(address agent, uint64 expiry, bool paused);
    event PolicyUpdated(string field);

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    constructor(address _owner, address _agent, address _oracle) {
        owner = _owner;
        agent = _agent;
        oracle = IPriceOracle(_oracle);
        agentExpiry = uint64(block.timestamp + 365 days);
        windowStart = uint64(block.timestamp);
    }

    // ------------------------------------------------------------ execution

    function execute(address target, bytes calldata data) external returns (bytes memory) {
        Call[] memory calls = new Call[](1);
        calls[0] = Call(target, data);
        return executeBatch(calls)[0];
    }

    function executeBatch(Call[] memory calls) public returns (bytes[] memory results) {
        require(msg.sender == owner || msg.sender == agent, "unauthorized");
        bool isAgent = msg.sender != owner;
        uint256 hfBefore;
        if (isAgent) {
            require(!agentPaused, "agent paused by owner");
            require(block.timestamp <= agentExpiry, "agent key expired");
            hfBefore = _health();
        }

        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; i++) {
            bytes4 sel = _selector(calls[i].data);
            if (isAgent) _checkAgentCall(calls[i].target, sel, calls[i].data);
            (bool ok, bytes memory ret) = calls[i].target.call(calls[i].data);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            results[i] = ret;
            emit Executed(msg.sender, calls[i].target, sel);
        }

        if (isAgent && address(healthSource) != address(0)) {
            uint256 hfAfter = _health();
            require(hfAfter >= minHealthFactor || hfAfter >= hfBefore, "health factor floor");
        }
    }

    function _checkAgentCall(address target, bytes4 sel, bytes memory data) internal {
        require(allowedCall[target][sel], "call not allowed by policy");
        if (sel == TRANSFER || sel == APPROVE) {
            require(data.length >= 68, "bad calldata");
            address to;
            uint256 amount;
            assembly {
                to := and(mload(add(data, 36)), 0xffffffffffffffffffffffffffffffffffffffff)
                amount := mload(add(data, 68))
            }
            require(allowedCounterparty[to], "counterparty not allowed");
            if (sel == TRANSFER) _charge(target, amount);
        }
    }

    function _charge(address token, uint256 amount) internal {
        if (block.timestamp >= windowStart + 1 days) {
            windowStart = uint64(block.timestamp);
            spentTodayUsd6 = 0;
        }
        uint256 usd = oracle.valueUsd6(token, amount);
        require(spentTodayUsd6 + usd <= dailyLimitUsd6, "daily outflow limit");
        spentTodayUsd6 += usd;
    }

    function _health() internal view returns (uint256) {
        if (address(healthSource) == address(0)) return type(uint256).max;
        return healthSource.healthFactor(address(this));
    }

    function _selector(bytes memory data) internal pure returns (bytes4 sel) {
        if (data.length < 4) return bytes4(0);
        assembly {
            sel := and(mload(add(data, 32)), 0xffffffff00000000000000000000000000000000000000000000000000000000)
        }
    }

    // ------------------------------------------------------------- views

    function remainingDailyUsd6() external view returns (uint256) {
        if (block.timestamp >= windowStart + 1 days) return dailyLimitUsd6;
        return dailyLimitUsd6 > spentTodayUsd6 ? dailyLimitUsd6 - spentTodayUsd6 : 0;
    }

    // ------------------------------------------------------------ owner only

    function setAgent(address newAgent, uint64 expiry) external onlyOwner {
        agent = newAgent;
        agentExpiry = expiry;
        emit AgentUpdated(newAgent, expiry, agentPaused);
    }

    function setAgentPaused(bool paused) external onlyOwner {
        agentPaused = paused;
        emit AgentUpdated(agent, agentExpiry, paused);
    }

    function setDailyLimit(uint256 usd6) external onlyOwner {
        dailyLimitUsd6 = usd6;
        emit PolicyUpdated("dailyLimit");
    }

    function setHealthGuard(address source, uint256 minHf) external onlyOwner {
        healthSource = IHealthSource(source);
        minHealthFactor = minHf;
        emit PolicyUpdated("healthGuard");
    }

    function setAllowedCalls(address[] calldata targets, bytes4[] calldata selectors, bool allowed) external onlyOwner {
        require(targets.length == selectors.length, "length mismatch");
        for (uint256 i; i < targets.length; i++) {
            allowedCall[targets[i]][selectors[i]] = allowed;
        }
        emit PolicyUpdated("allowedCalls");
    }

    function setCounterparties(address[] calldata who, bool allowed) external onlyOwner {
        for (uint256 i; i < who.length; i++) {
            allowedCounterparty[who[i]] = allowed;
        }
        emit PolicyUpdated("counterparties");
    }
}
