#!/usr/bin/env python3
"""
Test script to verify the automation module implementation.

This script tests the basic functionality of all automation components
to ensure they work correctly and integrate properly.
"""

import asyncio
import sys
import os
import time
from datetime import datetime, timedelta

# Add the benchmark source to the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from swarm_benchmark.automation import (
    BatchProcessor, BatchConfig, BatchResult,
    PipelineManager, Pipeline, PipelineStage,
    WorkflowExecutor, WorkflowConfig,
    ResourcePool, ResourceConfig, ResourceSpec,
    DecisionEngine, DecisionContext, DecisionType
)
from swarm_benchmark.core.models import BenchmarkTask


def create_test_tasks(count: int = 10) -> list:
    """Create test benchmark tasks."""
    tasks = []
    for i in range(count):
        task = BenchmarkTask(
            id=f"test_task_{i}",
            name=f"Test Task {i}",
            description=f"Test benchmark task number {i}",
            type="test",
            parameters={"test_param": i}
        )
        tasks.append(task)
    return tasks


async def test_batch_processor():
    """Test BatchProcessor functionality."""
    print("Testing BatchProcessor...")
    
    config = BatchConfig(
        max_parallel=5,
        timeout_seconds=60,
        retry_attempts=2
    )
    
    processor = BatchProcessor(config)
    tasks = create_test_tasks(10)
    
    try:
        result = await processor.process_batch(tasks)
        print(f"  ✅ Batch completed: {result.success_rate:.2%} success rate")
        print(f"     Tasks: {result.completed_tasks} completed, {result.failed_tasks} failed")
        return True
    except Exception as e:
        print(f"  ❌ BatchProcessor test failed: {e}")
        return False


async def test_resource_pool():
    """Test ResourcePool functionality."""
    print("Testing ResourcePool...")
    
    config = ResourceConfig(
        initial_pool_size=3,
        max_pool_size=10
    )
    
    try:
        async with ResourcePool(config) as pool:
            # Test resource allocation
            spec = ResourceSpec(cpu_cores=1.0, memory_mb=512)
            allocation = await pool.allocate_resource(spec, task_id="test_task")
            
            print(f"  ✅ Resource allocated: {allocation.allocation_id}")
            
            # Test resource release
            success = await pool.release_resource(allocation.allocation_id)
            print(f"  ✅ Resource released: {success}")
            
            # Test pool status
            status = await pool.get_pool_status()
            print(f"  ✅ Pool status: {status['total_resources']} resources, "
                  f"{status['cpu_utilization']:.2%} CPU utilization")
            
        return True
    except Exception as e:
        print(f"  ❌ ResourcePool test failed: {e}")
        return False


async def test_decision_engine():
    """Test DecisionEngine functionality."""
    print("Testing DecisionEngine...")
    
    try:
        engine = DecisionEngine(strategy="adaptive")
        
        # Create test context
        context = DecisionContext(
            current_metrics={"cpu_usage": 0.7, "memory_usage": 0.5},
            system_load=0.6
        )
        
        # Test decision making
        decision = await engine.make_decision(
            DecisionType.RESOURCE_ALLOCATION,
            context
        )
        
        print(f"  ✅ Decision made: {decision.selected_option.name}")
        print(f"     Confidence: {decision.confidence.value}")
        print(f"     Rationale: {decision.rationale[:80]}...")
        
        # Test decision execution
        success = await engine.execute_decision(decision)
        print(f"  ✅ Decision executed: {success}")
        
        return True
    except Exception as e:
        print(f"  ❌ DecisionEngine test failed: {e}")
        return False


async def test_workflow_executor():
    """Test WorkflowExecutor functionality."""
    print("Testing WorkflowExecutor...")
    
    config = WorkflowConfig(
        execution_strategy="adaptive",
        max_parallel_tasks=5,
        timeout_seconds=120
    )
    
    executor = WorkflowExecutor(config)
    
    try:
        objective = "Run a comprehensive benchmark test with multiple task types"
        result = await executor.execute_autonomous_workflow(objective)
        
        print(f"  ✅ Workflow completed: {result.status.value}")
        print(f"     Success rate: {result.success_rate:.2%}")
        print(f"     Tasks: {result.tasks_completed} completed, {result.tasks_failed} failed")
        print(f"     Duration: {result.total_duration:.2f}s")
        
        return True
    except Exception as e:
        print(f"  ❌ WorkflowExecutor test failed: {e}")
        return False


async def test_pipeline_manager():
    """Test PipelineManager functionality."""
    print("Testing PipelineManager...")
    
    try:
        manager = PipelineManager()
        
        # Create a simple ML pipeline
        pipeline = manager.create_ml_pipeline("test_ml_pipeline", {
            "data_sources": ["test_data"],
            "model_configs": [{"type": "test_model"}],
            "metrics": ["accuracy"],
            "report_formats": ["json"]
        })
        
        print(f"  ✅ Pipeline created: {pipeline.name}")
        
        # Execute pipeline
        result = await manager.execute_pipeline("test_ml_pipeline")
        
        print(f"  ✅ Pipeline executed: {result.status.value}")
        print(f"     Success rate: {result.success_rate:.2%}")
        
        return True
    except Exception as e:
        print(f"  ❌ PipelineManager test failed: {e}")
        return False


async def run_integration_test():
    """Run integrated test using multiple components."""
    print("Testing Integration...")
    
    try:
        # Initialize components
        batch_config = BatchConfig(max_parallel=3)
        resource_config = ResourceConfig(initial_pool_size=2)
        workflow_config = WorkflowConfig(max_parallel_tasks=3)
        
        processor = BatchProcessor(batch_config)
        executor = WorkflowExecutor(workflow_config)
        
        # Create test scenario
        tasks = create_test_tasks(5)
        
        # Execute using batch processor
        batch_result = await processor.process_batch(tasks)
        
        # Execute autonomous workflow
        workflow_result = await executor.execute_autonomous_workflow(
            "Process test tasks with optimal resource allocation"
        )
        
        print(f"  ✅ Integration test completed")
        print(f"     Batch success: {batch_result.success_rate:.2%}")
        print(f"     Workflow success: {workflow_result.success_rate:.2%}")
        
        return True
    except Exception as e:
        print(f"  ❌ Integration test failed: {e}")
        return False


async def main():
    """Run all automation tests."""
    print("=" * 60)
    print("🤖 AUTOMATION MODULE IMPLEMENTATION TEST")
    print("=" * 60)
    print()
    
    start_time = time.time()
    tests_passed = 0
    total_tests = 6
    
    # Run individual component tests
    test_results = await asyncio.gather(
        test_batch_processor(),
        test_resource_pool(),
        test_decision_engine(),
        test_workflow_executor(),
        test_pipeline_manager(),
        run_integration_test(),
        return_exceptions=True
    )
    
    # Count successful tests
    for i, result in enumerate(test_results):
        if isinstance(result, Exception):
            print(f"  ❌ Test {i+1} failed with exception: {result}")
        elif result:
            tests_passed += 1
    
    duration = time.time() - start_time
    
    print()
    print("=" * 60)
    print("📊 TEST SUMMARY")
    print("=" * 60)
    print(f"Tests passed: {tests_passed}/{total_tests}")
    print(f"Success rate: {tests_passed/total_tests:.1%}")
    print(f"Total duration: {duration:.2f}s")
    
    if tests_passed == total_tests:
        print("🎉 All tests passed! Automation module is working correctly.")
        return 0
    else:
        print("⚠️  Some tests failed. Check implementation.")
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))